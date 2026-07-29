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
/** Enter 로 갓 생긴 **빈** 문단의 밴드(글리프 0개) — 캐럿은 밴드 왼쪽/높이로만 선다. */
const NEXT_BAND: BlockHit = { ...BAND, block: 4, y: 60, text: "" };
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

function engineCaretWorkspace(adapter: MockAdapter) {
  return render(
    <HwpWorkspace
      adapter={adapter}
      document={{ bytes: new Uint8Array([1]), name: "t.hwp" }}
      onAiRequest={async () => []}
      enableEditing
      preferEngineCaretEditing
    />,
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
  it("Figma 편집 옵션: 더블클릭도 원본 SVG를 덮는 contentEditable 없이 엔진 캐럿을 유지한다", async () => {
    const { container } = engineCaretWorkspace(bodyAdapter());
    const sheet = await sheetOf(container);
    click(sheet, 112, 45);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
    click(sheet, 112, 45);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
    expect(container.querySelector('[data-testid="hw-inplace-editor"]')).toBeNull();
    expect(sheet.querySelector("svg")).toBeTruthy();
  });

  it("디자인 inspector의 문단 굵게는 원문/런을 보존한 SetParagraphRuns 하나로 적용한다", async () => {
    const adapter = bodyAdapter();
    const { container } = render(
      <HwpWorkspace
        adapter={adapter}
        document={{ bytes: new Uint8Array([1]), name: "t.hwp" }}
        onAiRequest={async () => []}
        enableEditing
        preferEngineCaretEditing
        sidePanel={(api) => (
          <button
            type="button"
            data-testid="paragraph-design-bold"
            disabled={!api.designSelection?.canTextStyle}
            onClick={() => api.applyDesign?.({ bold: true })}
          >
            문단 굵게
          </button>
        )}
      />,
    );
    const sheet = await sheetOf(container);
    click(sheet, 112, 45);
    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="paragraph-design-bold"]') as HTMLButtonElement | null;
      expect(el?.disabled).toBe(false);
      return el!;
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(adapter.applied).toHaveLength(1);
      expect(adapter.applied[0]).toMatchObject({
        intent: "SetParagraphRuns",
        section: 0,
        block: 3,
        runs: [{ text: "가나", bold: true }, { text: " 다", bold: true }],
      });
    });
  });

  it("디자인 inspector의 굵게는 실제 글자 범위가 있으면 문단 전체가 아닌 그 범위만 토글한다", async () => {
    const adapter = bodyAdapter();
    const { container } = render(
      <HwpWorkspace
        adapter={adapter}
        document={{ bytes: new Uint8Array([1]), name: "t.hwp" }}
        onAiRequest={async () => []}
        enableEditing
        preferEngineCaretEditing
        sidePanel={(api) => (
          <button type="button" data-testid="range-design-bold" onClick={() => api.applyDesign?.({ bold: true })}>
            범위 굵게
          </button>
        )}
      />,
    );
    await caretAt(container, 112, 45); // 가|나
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true }); // "나" 선택
    await waitFor(() => expect(container.querySelectorAll(".hw-selrange-box")).toHaveLength(1));
    fireEvent.click(container.querySelector('[data-testid="range-design-bold"]')!);

    await waitFor(() => {
      expect(adapter.applied).toEqual([
        {
          intent: "SetParagraphRuns",
          section: 0,
          block: 3,
          runs: [{ text: "가", bold: true }, { text: "나 다" }],
        },
      ]);
    });
  });

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

  // ── 글자 범위 선택 (Shift+방향키 · Shift+클릭 · ⌘A · ⌘B) ───────────────────────────────────────

  const rangeBoxes = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-testid="hw-selrange"] .hw-selrange-box')) as HTMLElement[];

  it("Shift+방향키는 범위를 넓혀 하이라이트를 그린다 — 시트 0 렌더 · 워크스페이스 0 렌더 · 인텐트 0", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    const caret = await caretAt(container, 101, 45); // offset 0
    await flush();
    expect(rangeBoxes(container)).toHaveLength(0); // 범위 없음 = 사각형 없음

    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();
    for (const _ of [0, 1]) {
      fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
      await flush();
    }
    const boxes = rangeBoxes(container);
    expect(boxes).toHaveLength(1);
    const s = parseFloat(caret.style.height) / 13; // 스케일 역산(셀 캐럿 스펙과 같은 기법)
    expect(parseFloat(boxes[0].style.left)).toBeCloseTo(100 * s, 3); // '가'의 왼쪽부터
    expect(parseFloat(boxes[0].style.width)).toBeCloseTo(26 * s, 3); // '가나' 두 글자 폭
    expect(parseFloat(caret.style.left)).toBeCloseTo(126 * s, 3); // 막대는 이동단(offset 2 = 공백 앞)에
    expect(__getSheetRenderCount()).toBe(0);
    expect(__getWorkspaceRenderCount()).toBe(0);
    expect(adapter.applied).toHaveLength(0);

    // 되감으면 하이라이트가 사라진다(같은 ref 경로 — 여전히 리렌더 0).
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    await flush();
    expect(rangeBoxes(container)).toHaveLength(0);
    expect(__getSheetRenderCount()).toBe(0);
    expect(__getWorkspaceRenderCount()).toBe(0);
  });

  it("Shift+클릭은 캐럿에서 클릭 자리까지 범위를 만든다", async () => {
    const { container } = workspace(bodyAdapter());
    await caretAt(container, 101, 45); // offset 0
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 132, clientY: 45, button: 0, buttons: 1, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(sheet, { clientX: 132, clientY: 45, button: 0, buttons: 0, pointerId: 1, shiftKey: true });
    await waitFor(() => expect(rangeBoxes(container)).toHaveLength(1));
  });

  it("마우스 드래그는 같은 문단의 글자 범위를 ref로 만든다 — 이동 중 시트/워크스페이스 렌더 0", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container, 112, 45); // 먼저 캐럿 활성
    const sheet = await sheetOf(container);

    fireEvent.pointerDown(sheet, { clientX: 101, clientY: 45, button: 0, buttons: 1, pointerId: 7 });
    await flush(); // 비동기 hit-test가 텍스트 레인 소유권을 얻고 pointerActive 렌더가 끝난 뒤 계측
    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();
    for (const x of [112, 124, 132, 500]) {
      fireEvent.pointerMove(sheet, { clientX: x, clientY: 45, button: 0, buttons: 1, pointerId: 7 });
      await flush();
    }
    await waitFor(() => expect(rangeBoxes(container)).toHaveLength(1));
    expect(__getSheetRenderCount()).toBe(0);
    expect(__getWorkspaceRenderCount()).toBe(0);
    expect(adapter.applied).toHaveLength(0); // 드래그 자체는 읽기 전용

    fireEvent.pointerUp(sheet, { clientX: 500, clientY: 45, button: 0, buttons: 0, pointerId: 7 });
    await flush();
    fireEvent.keyDown(window, { key: "X" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied.every((i) => i.intent === "SetParagraphRuns")).toBe(true); // mutation: 평문 op 금지
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs.map((r) => r.text).join("")).toBe("X");
  });

  it("범위 위 타이핑은 범위를 대체하고, Backspace는 범위를 지운다", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container, 101, 45);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    await flush();
    fireEvent.keyDown(window, { key: "X" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs.map((r) => r.text).join("")).toBe("X 다");
  });

  it("⌘V 여러 줄 평문은 범위를 대체하고 SetParagraphRuns 한 번만 커밋한다", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container, 101, 45);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true }); // "가나" 범위
    await flush();

    const e = new Event("paste", { cancelable: true, bubbles: true }) as ClipboardEvent;
    Object.defineProperty(e, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "X\r\nY" : "") },
    });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied.map((i) => i.intent)).toEqual(["SetParagraphRuns"]);
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs.map((r) => r.text).join("")).toBe("X\nY 다");
  });

  it("⌘A는 문단 전체를 선택하고 ⌘B는 그 범위만 굵게 커밋한다(런 보존)", async () => {
    const adapter = bodyAdapter({ runs: [{ text: "가나 다" }] });
    const { container } = workspace(adapter);
    await caretAt(container, 101, 45);
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await waitFor(() => expect(rangeBoxes(container)).toHaveLength(1));
    expect(adapter.applied).toHaveLength(0); // 선택은 커밋이 아니다
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0]).toEqual({
      intent: "SetParagraphRuns",
      section: 0,
      block: 3,
      runs: [{ text: "가나 다", bold: true }],
    } as Intent);
  });

  it("캐럿이 없으면 ⌘A/⌘B는 우리 것이 아니다(브라우저 기본동작 유지 · 인텐트 0)", async () => {
    const adapter = bodyAdapter();
    workspace(adapter);
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    await flush();
    expect(adapter.applied).toHaveLength(0);
  });

  // ── Enter = 문단 분리 (SplitParagraph) ────────────────────────────────────────────────────────

  it("Enter는 캐럿 자리에서 문단을 나눈다 — SplitParagraph 하나 = undo 하나", async () => {
    const adapter = bodyAdapter({
      hit: (_p, _x, y) => (y >= 40 && y <= 60 ? BAND : y >= 60 && y <= 80 ? NEXT_BAND : null),
      blocks: [BAND, NEXT_BAND],
      runs: (_s: number, b: number) => (b === 4 ? [{ text: "" }] : RUNS.map((r) => ({ ...r }))),
    });
    const { container } = workspace(adapter);
    await caretAt(container); // offset 1
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0]).toEqual({ intent: "SplitParagraph", section: 0, block: 3, at: 1 } as Intent);
    // 새 문단은 비어 있어도 캐럿이 남는다(밴드 기반 빈 줄 박스) — Enter 뒤 계속 칠 수 있어야 한다.
    await waitFor(() => {
      const caret = container.querySelector(".hw-caret") as HTMLElement | null;
      expect(caret).toBeTruthy();
      const s = parseFloat(caret!.style.height) / 20; // NEXT_BAND.h
      expect(parseFloat(caret!.style.left)).toBeCloseTo(75 * s, 3); // 밴드 왼쪽
    });
  });

  it("문단 맨 앞 Backspace는 앞 문단과 병합한다(MergeParagraph)", async () => {
    const adapter = bodyAdapter();
    const { container } = workspace(adapter);
    await caretAt(container, 101, 45); // offset 0
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0]).toEqual({ intent: "MergeParagraph", section: 0, block: 3 } as Intent);
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
