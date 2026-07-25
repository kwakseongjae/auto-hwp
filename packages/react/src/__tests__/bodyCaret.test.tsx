import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, __getWorkspaceRenderCount, __resetWorkspaceRenderCount } from "../components/HwpWorkspace";
import { __getSheetRenderCount, __resetSheetRenderCount } from "../components/HwpPageView";
import type { BlockHit, Intent, RunSpec } from "../types";
import { MockAdapter } from "./mockAdapter";

// 본문 문단 글자 캐럿 — 표 셀 밖 문단을 클릭해 캐럿을 세우고 타이핑하는 절반(CARET-GAP §7.4의 남은 갭).
// 셀 캐럿(053)과 같은 UI 계약을 쓰되(같은 `.hw-caret`, 같은 IME 표면, 같은 render-0 규율) 기하는 화면에
// 주입되는 **페이지 SVG의 글리프**에서 오고, 커밋은 `SetParagraphRuns`(런 보존 variant)로 간다.

const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const click = (el: Element, x: number, y: number) => {
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1 });
};
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 문단 "가나 다"의 own-render 산출물: 글리프 3개(공백은 렌더러가 생략), 전각 advance 13, baseline 50. */
const PAGE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="794" height="1123">` +
  `<rect x="0" y="0" width="794" height="1123" fill="#FFFFFF"/>` +
  `<text x="100.00" y="50.00" font-size="13.00" font-family="NanumGothic, sans-serif" fill="#000000">가</text>` +
  `<text x="113.00" y="50.00" font-size="13.00" font-family="NanumGothic, sans-serif" font-weight="700" fill="#000000">나</text>` +
  `<text x="130.00" y="50.00" font-size="13.00" font-family="NanumGothic, sans-serif" fill="#000000">다</text>` +
  `</svg>`;

const BAND: BlockHit = { section: 0, block: 3, kind: "paragraph", x: 75, y: 40, w: 20, h: 20, text: "가나 다", editable: true };
const RUNS: RunSpec[] = [{ text: "가나", bold: true }, { text: " 다" }];

/** 본문 문단만 있는 백엔드(셀 캐럿 표면 없음) — 클릭은 문단 밴드(y 40..60)에서만 해소된다. */
function bodyAdapter(over: Partial<ConstructorParameters<typeof MockAdapter>[0]> = {}) {
  return new MockAdapter({
    svg: () => PAGE_SVG,
    hit: (_p, _x, y) => (y >= 40 && y <= 60 ? BAND : null),
    blocks: [BAND],
    runs: RUNS.map((r) => ({ ...r })),
    ...over,
  });
}

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]') as HTMLElement | null;
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

function workspace(adapter: MockAdapter) {
  return render(
    <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwp" }} onAiRequest={async () => []} enableEditing />,
  );
}

/** 캐럿을 '가|나' 자리에 세우고 그 엘리먼트를 돌려준다. */
async function caretAt(container: HTMLElement, x = 112, y = 45): Promise<HTMLElement> {
  const sheet = await sheetOf(container);
  click(sheet, x, y);
  return waitFor(() => {
    const el = container.querySelector(".hw-caret") as HTMLElement | null;
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
}

describe("body paragraph caret", () => {
  it("본문 문단을 클릭하면 그 글자 자리에 캐럿이 선다(글리프 x에 스냅, top=baseline−0.85h)", async () => {
    const { container } = workspace(bodyAdapter());
    const caret = await caretAt(container);
    // 스케일 무관 검증(셀 캐럿 스펙과 동일 기법): 높이 13 page-px에서 스케일을 역산한다.
    const s = parseFloat(caret.style.height) / 13;
    expect(s).toBeGreaterThan(0);
    expect(parseFloat(caret.style.left)).toBeCloseTo(113 * s, 3); // '나'의 왼쪽 = offset 1
    expect(parseFloat(caret.style.top)).toBeCloseTo((50 - 13 * 0.85) * s, 3);
  });

  it("문단 밖(빈 곳) 클릭은 캐럿을 세우지 않고 기존 캐럿도 지운다(018 null 정책)", async () => {
    const { container } = workspace(bodyAdapter());
    await caretAt(container);
    const sheet = await sheetOf(container);
    click(sheet, 112, 400); // 밴드 밖 → hitTest null
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeNull());
  });

  it("타이핑은 키 하나당 SetParagraphRuns 하나 — 런 스타일이 보존된다(평문 variant 금지)", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container);

    fireEvent.keyDown(window, { key: "X" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0]).toEqual({
      intent: "SetParagraphRuns",
      section: 0,
      block: 3,
      runs: [{ text: "가X나", bold: true }, { text: " 다" }],
    } as Intent);
    expect(container.querySelector(".hw-caret")).toBeTruthy(); // 커밋 후에도 캐럿은 살아 있다
  });

  it("Backspace는 캐럿 앞 글자를 지운다(같은 SetParagraphRuns 레인)", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container);
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "나", bold: true }, { text: " 다" }]);
  });

  it("좌우 방향키는 ref 쓰기로만 캐럿을 옮긴다 — 시트 0 렌더 · 워크스페이스 0 렌더 · 인텐트 0", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container);
    await flush();

    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();
    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowRight"]) {
      fireEvent.keyDown(window, { key });
      await flush();
    }
    const caret = container.querySelector(".hw-caret") as HTMLElement;
    const s = parseFloat(caret.style.height) / 13;
    expect(parseFloat(caret.style.left)).toBeCloseTo(130 * s, 3); // offset 3 = '다'의 왼쪽
    expect(__getSheetRenderCount()).toBe(0);
    expect(__getWorkspaceRenderCount()).toBe(0);
    expect(adapter.applied).toHaveLength(0); // 이동은 읽기 전용 — undo 단위가 생기면 안 된다
  });

  it("문단 경계 방향키는 캐럿을 지우지 않는다(셀 캐럿의 셀-이동 강등과 다른 지점)", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container, 101, 45); // offset 0
    for (const key of ["ArrowLeft", "ArrowUp", "ArrowDown"]) {
      fireEvent.keyDown(window, { key });
      await flush();
    }
    expect(container.querySelector(".hw-caret")).toBeTruthy();
    expect(adapter.applied).toHaveLength(0);
  });

  it("한글 IME 조합은 기존 조합 표면을 그대로 쓰고, 확정본만 SetParagraphRuns 하나로 커밋된다", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container);
    const ta = (await waitFor(() => {
      const el = container.querySelector('[data-testid="hw-ime-input"]') as HTMLTextAreaElement | null;
      expect(el).toBeTruthy();
      return el as HTMLTextAreaElement;
    })) as HTMLTextAreaElement;

    fireEvent.compositionStart(ta, { data: "" });
    fireEvent.compositionUpdate(ta, { data: "하" });
    await flush();
    expect(container.querySelector('[data-testid="hw-ime-preview"]')?.textContent).toBe("하");
    expect(adapter.applied).toHaveLength(0); // 조합 중에는 아무것도 커밋되지 않는다
    fireEvent.compositionEnd(ta, { data: "한" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0].intent).toBe("SetParagraphRuns");
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "가한나", bold: true }, { text: " 다" }]);
  });

  it("Escape는 본문 캐럿도 지운다", async () => {
    const { container } = workspace(bodyAdapter());
    await caretAt(container);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeNull());
  });

  it("페이지 SVG에 글리프가 없으면(정렬 불가) 캐럿을 만들지 않는다 — 틀린 자리보다 무캐럿", async () => {
    const adapter = bodyAdapter({ svg: () => `<svg viewBox="0 0 794 1123" width="794" height="1123"></svg>` });
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);
    click(sheet, 112, 45);
    await flush();
    await flush();
    expect(container.querySelector(".hw-caret")).toBeNull();
  });
});
