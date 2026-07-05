import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, __getWorkspaceRenderCount, __resetWorkspaceRenderCount } from "../components/HwpWorkspace";
import { ImageOverlay } from "../components/ImageOverlay";
import type { BlockHit, ImageBox, Intent } from "../types";
import { MockAdapter } from "./mockAdapter";

// Image move/resize SDK (issue 049): the ImageOverlay unit + the HwpWorkspace image selection / handle /
// commit wiring. jsdom does no layout → getBoundingClientRect is stubbed to a full A4 box so coords.ts maps
// clicks to page px (client px == page px at viewBox 794×1123, scale 1).

const origRect = Element.prototype.getBoundingClientRect;
const origEFP = document.elementsFromPoint;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
  document.elementsFromPoint = origEFP;
});

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };

// An image anchored at (section 0, block 2), box {100,100,200,100} (aspect 2:1).
const IMG: ImageBox = { x: 100, y: 100, w: 200, h: 100, section: 0, block: 2 };
const imageResolver = (_p: number, x: number, y: number): ImageBox | null =>
  x >= IMG.x && x <= IMG.x + IMG.w && y >= IMG.y && y <= IMG.y + IMG.h ? IMG : null;

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

// Select the image by clicking inside it (a pointerDown+Up the workspace probes via imageAt).
async function selectImage(sheet: HTMLElement) {
  fireEvent.pointerDown(sheet, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
  return screen.findByTestId("hw-image-overlay");
}

const wDown = (el: Element | Window, x: number, y: number, shift = false) =>
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, shiftKey: shift });
const wMove = (x: number, y: number, shift = false) =>
  fireEvent.pointerMove(window, { clientX: x, clientY: y, buttons: 1, pointerId: 1, shiftKey: shift });
const wUp = (x: number, y: number, shift = false) =>
  fireEvent.pointerUp(window, { clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1, shiftKey: shift });

// ── ImageOverlay — presentational unit (issue 049) ────────────────────────────────────────────────────
describe("ImageOverlay (issue 049) — 8 handles, aspect-lock corners, render via local state", () => {
  it("renders the box + all 8 resize handles and reports a corner resize with the aspect held", () => {
    let committed: { w: number; h: number } | null = null;
    render(
      <ImageOverlay
        box={{ x: 100, y: 100, w: 200, h: 100 }}
        scale={1}
        onCommitResize={(b) => (committed = { w: b.w, h: b.h })}
        onCommitMove={() => {}}
        onDismiss={() => {}}
      />,
    );
    for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) expect(screen.getByTestId(`hw-image-handle-${h}`)).toBeTruthy();
    // SE corner drag by (100,10): aspect (2:1) holds → w 300, h 150 (NOT the raw 110).
    wDown(screen.getByTestId("hw-image-handle-se"), 300, 200);
    wMove(400, 210);
    wUp(400, 210);
    expect(committed).not.toBeNull();
    expect(committed!.w).toBe(300);
    expect(committed!.h).toBe(150);
  });

  it("Shift releases the corner aspect lock (free both-axis resize)", () => {
    let committed: { w: number; h: number } | null = null;
    render(
      <ImageOverlay box={{ x: 100, y: 100, w: 200, h: 100 }} scale={1} onCommitResize={(b) => (committed = { w: b.w, h: b.h })} onCommitMove={() => {}} onDismiss={() => {}} />,
    );
    wDown(screen.getByTestId("hw-image-handle-se"), 300, 200, true);
    wMove(400, 210, true);
    wUp(400, 210, true);
    expect(committed!.w).toBe(300);
    expect(committed!.h).toBe(110); // NOT snapped to the 2:1 ratio
  });
});

// ── HwpWorkspace integration — select → overlay → resize/move + 적용-확인 ───────────────────────────────
describe("HwpWorkspace image select + resize (issue 049)", () => {
  it("이미지 클릭 → 8핸들 오버레이 선택; 핸들 드래그 → SetImageSize(HWPUNIT) + 적용-확인 성공 토스트", async () => {
    const adapter = new MockAdapter({ image: imageResolver, imageBox: { ...IMG }, liveImage: true, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await selectImage(sheet);
    // SE handle drag +100/+10 → aspect-locked 300×150 page px → HWPUNIT ×75.
    wDown(screen.getByTestId("hw-image-handle-se"), 300, 200);
    wMove(400, 210);
    wUp(400, 210);
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetImageSize") as (Intent & { section: number; index: number; width: number; height: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied).toMatchObject({ section: 0, index: 2 });
      // HWPUNIT sizes are positive and GREW from the original (200×100 px → ×75). The exact px depends on
      // the live zoom scale (a jsdom artifact); the ImageOverlay UNIT test pins the exact 300×150 math.
      expect(applied!.width).toBeGreaterThan(200 * 75);
      expect(applied!.height).toBeGreaterThan(100 * 75);
      // aspect held through the commit (거짓 자유도 없음): width/height ratio == the original 2:1.
      expect(applied!.width / applied!.height).toBeCloseTo(2, 3);
    });
    await waitFor(() => expect(screen.getByText("이미지 크기를 변경했습니다")).toBeTruthy());
  });

  it("FROZEN engine → 리사이즈가 반영 안 되면 정직한 실패 토스트 (적용-확인, 거짓 성공 차단)", async () => {
    // No liveImage → the image box stays frozen: the apply-verify must surface the honest failure.
    const adapter = new MockAdapter({ image: imageResolver, imageBox: { ...IMG }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await selectImage(sheet);
    wDown(screen.getByTestId("hw-image-handle-e"), 300, 150);
    wMove(360, 150);
    wUp(360, 150);
    await waitFor(() => expect(adapter.applied.some((i) => i.intent === "SetImageSize")).toBe(true));
    await waitFor(() => expect(screen.getByText("이미지 크기 변경이 반영되지 않았습니다 — 다시 시도하세요")).toBeTruthy());
    expect(screen.queryByText("이미지 크기를 변경했습니다")).toBeNull();
  });

  it("드래그 중 워크스페이스 렌더 0 (계측), 커밋 후 재렌더 (issue 030 정합)", async () => {
    const adapter = new MockAdapter({ image: imageResolver, imageBox: { ...IMG }, liveImage: true, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await selectImage(sheet);
    // Start a resize drag, THEN reset the counter (selection itself renders once).
    wDown(screen.getByTestId("hw-image-handle-se"), 300, 200);
    __resetWorkspaceRenderCount();
    for (let i = 0; i < 30; i++) wMove(300 + i * 3, 200 + i);
    const during = __getWorkspaceRenderCount();
    // eslint-disable-next-line no-console
    console.log(`[049] during 30 handle moves — workspace renders=${during}`);
    expect(during).toBe(0); // the drag lives in the overlay's LOCAL state — the workspace never re-renders
    wUp(390, 230);
    // the commit re-places the overlay → at least one workspace render settles.
    await waitFor(() => expect(__getWorkspaceRenderCount()).toBeGreaterThanOrEqual(1));
  });

  it("이미지 밖 클릭 → 선택 해제(오버레이 사라짐)", async () => {
    const adapter = new MockAdapter({ image: imageResolver, imageBox: { ...IMG }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await selectImage(sheet);
    // Click off the image (400,400 → imageResolver returns null) → the overlay clears.
    fireEvent.pointerDown(sheet, { clientX: 400, clientY: 400, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 400, clientY: 400, button: 0, pointerId: 1 });
    await waitFor(() => expect(screen.queryByTestId("hw-image-overlay")).toBeNull());
  });

  it("imageAt를 지원하지 않는 백엔드(TauriAdapter식 생략) → 오버레이 없음 (동형 파리티)", async () => {
    const adapter = new MockAdapter({ pages: 1 }); // no image opt → imageAt omitted
    expect(adapter.imageAt).toBeUndefined();
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    // no imageAt → no overlay ever appears (graceful; other selection still works).
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("hw-image-overlay")).toBeNull();
  });
});

// ── HwpWorkspace integration — move = ANCHOR REORDER (drop → hitTest block) ────────────────────────────
describe("HwpWorkspace image move (issue 049) — 앵커 이동(드롭 지점의 블록으로), 거짓 자유도 없음", () => {
  it("본문 드래그 → 드롭 지점의 블록으로 MoveImage(from,to) + 적용-확인", async () => {
    // hitTest returns a paragraph block 5 at the drop area (same section) — the move TARGET.
    const dropBlock: BlockHit = { section: 0, block: 5, kind: "paragraph", x: 300, y: 500, w: 200, h: 40, text: "타깃", editable: true };
    const adapter = new MockAdapter({
      image: imageResolver,
      imageBox: { ...IMG },
      liveImage: true,
      hit: (_p, _x, y) => (y > 300 ? dropBlock : null),
      pages: 1,
    });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    const overlay = await selectImage(sheet);
    // jsdom has no layout → stub elementsFromPoint so resolveDropBlock finds the page sheet under the drop.
    document.elementsFromPoint = () => [sheet];
    // Drag the overlay BODY from inside the image down to (300,500) — past the move threshold.
    wDown(overlay, 150, 150);
    wMove(300, 500);
    wUp(300, 500);
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "MoveImage") as (Intent & { section: number; from: number; to: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied).toMatchObject({ section: 0, from: 2, to: 5 });
    });
    await waitFor(() => expect(screen.getByText("이미지를 이동했습니다")).toBeTruthy());
  });

  it("제자리(같은 블록/미스) 드롭 → no-op (MoveImage 미발생)", async () => {
    const adapter = new MockAdapter({ image: imageResolver, imageBox: { ...IMG }, liveImage: true, hit: () => null, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    const overlay = await selectImage(sheet);
    document.elementsFromPoint = () => [sheet];
    wDown(overlay, 150, 150);
    wMove(320, 260);
    wUp(320, 260);
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.applied.some((i) => i.intent === "MoveImage")).toBe(false);
  });
});
