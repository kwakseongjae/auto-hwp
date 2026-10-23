import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode, createRef, useEffect, useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HwpPageView, type PageViewHandle } from "../components/HwpPageView";
import { HwpWorkspace, type WorkspaceHandle, type WorkspaceHandleChange, type WorkspaceSidePanel, type WorkspaceTextFormat } from "../components/HwpWorkspace";
import type { BlockHit, CellHit, Intent, RunSpec, TableBox } from "../types";
import { useWorkspaceState } from "../useWorkspaceState";
import { MockAdapter } from "./mockAdapter";

// #482 — 작업 공간 핸들. 호스트가 자기 크롬(메뉴 · 도구 막대 · 상태 막대)을 만들 때 숨은 DOM 을 읽거나 단축키를
// 흉내 내지 않고, 내장 도구 막대 · 단축키와 **같은 레인**을 부른다. 핸들 정체성은 렌더 사이에 같다.

const origRect = Element.prototype.getBoundingClientRect;
const origScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  // jsdom does no layout. Every box is an A4 sheet at the origin, EXCEPT page wrappers, which stack one page
  // apart — so the reading-line page calc (`pageAtReference`) sees page 0 at the top, like a real canvas.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const page = (this as HTMLElement).dataset?.page;
    const top = page != null && this.classList.contains("hw-sheet-wrap") ? Number(page) * 1123 : 0;
    return { left: 0, top, right: 794, bottom: top + 1123, width: 794, height: 1123, x: 0, y: top, toJSON() {} } as DOMRect;
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});
afterEach(() => {
  Element.prototype.scrollIntoView = origScrollIntoView;
  vi.restoreAllMocks();
});

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const flush = () => new Promise((r) => setTimeout(r, 0));

async function sheetOf(container: HTMLElement, page = 0): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector(`.hw-sheet[data-page="${page}"]`) as HTMLElement | null;
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

function mount(adapter: MockAdapter, extra: Partial<Parameters<typeof HwpWorkspace>[0]> = {}) {
  const ref = createRef<WorkspaceHandle>();
  let panelApi: WorkspaceSidePanel | null = null;
  const utils = render(
    <HwpWorkspace
      adapter={adapter}
      document={doc}
      onAiRequest={noAi}
      handleRef={ref}
      sidePanel={(api) => {
        panelApi = api;
        return null;
      }}
      {...extra}
    />,
  );
  return { ...utils, ref, api: () => panelApi as WorkspaceSidePanel | null };
}

describe("WorkspaceHandle — 정체성 · 보기", () => {
  it("핸들은 렌더 사이에 같은 객체이고 사이드 패널 api 의 handle 과 같다", async () => {
    const { ref, container, rerender, api } = mount(new MockAdapter({ pages: 2 }));
    await sheetOf(container);
    const first = ref.current;
    expect(first).toBeTruthy();
    rerender(<HwpWorkspace adapter={new MockAdapter({ pages: 2 })} document={doc} onAiRequest={noAi} handleRef={ref} className="again" />);
    expect(ref.current).toBe(first);
    expect(api()?.handle).toBe(first);
  });

  it("setZoom 은 정확한 배율로 커밋하고 subscribe 는 한 번 알린다", async () => {
    const { ref, container } = mount(new MockAdapter({ pages: 1 }));
    await sheetOf(container);
    const h = ref.current!;
    const seen: WorkspaceHandleChange[] = [];
    const off = h.subscribe((c) => seen.push(c));
    act(() => {
      expect(h.setZoom(0.75)).toBe(0.75);
    });
    expect(h.getZoom()).toBe(0.75);
    expect(container.querySelector(".hw-zoom")?.textContent).toBe("75%");
    expect(seen.filter((c) => c.zoom)).toHaveLength(1);
    off();
    act(() => {
      h.setZoom(2);
    });
    expect(h.getZoom()).toBe(2);
    expect(seen.filter((c) => c.zoom)).toHaveLength(1); // 해지 뒤에는 알리지 않는다
    act(() => {
      expect(h.setZoom(99)).toBe(4); // 작업 공간 상한으로 자른다
    });
    expect(h.getZoom()).toBe(4);
  });

  it("getPage 는 지금 쪽과 쪽 수를 준다", async () => {
    const { ref, container } = mount(new MockAdapter({ pages: 3 }));
    await sheetOf(container);
    expect(ref.current!.getPage()).toEqual({ current: 0, count: 3 });
  });

  it("스크롤로 지금 쪽이 바뀌면 상태 막대와 같은 쪽을 주고 page 를 한 번 알린다", async () => {
    const { ref, container } = mount(new MockAdapter({ pages: 3 }));
    await sheetOf(container);
    const h = ref.current!;
    const seen: WorkspaceHandleChange[] = [];
    h.subscribe((c) => seen.push(c));
    // 캔버스를 두 쪽 아래로 내린 것처럼 — 쪽 틀이 위로 올라간다
    const shifted = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const r = shifted.call(this);
      const page = (this as HTMLElement).dataset?.page;
      if (page == null || !this.classList.contains("hw-sheet-wrap")) return r;
      const top = r.top - 2 * 1123;
      return { ...r, top, y: top, bottom: top + 1123, toJSON() {} } as DOMRect;
    };
    try {
      await act(async () => {
        container.querySelector(".hw-canvas")!.dispatchEvent(new Event("scroll"));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });
      expect(h.getPage()).toEqual({ current: 2, count: 3 });
      expect(container.querySelector('[data-testid="hw-statusbar-page"]')?.textContent).toContain("3");
      expect(seen.filter((c) => c.page)).toHaveLength(1);
    } finally {
      Element.prototype.getBoundingClientRect = shifted;
    }
  });

  it("scrollToPage 는 이 작업 공간 캔버스의 쪽만 민다(같은 화면의 다른 쪽 보기는 그대로)", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const adapter = new MockAdapter({ pages: 3 });
    const ref = createRef<WorkspaceHandle>();
    const { container } = render(
      <div>
        <div data-testid="other">
          <HwpPageView adapter={new MockAdapter({ pages: 3 })} pageCount={3} />
        </div>
        <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} handleRef={ref} />
      </div>,
    );
    await sheetOf(container.querySelector(".hw-canvas") as HTMLElement, 1);
    ref.current!.scrollToPage(1);
    expect(scrolled).toHaveLength(1);
    expect(container.querySelector(".hw-canvas")?.contains(scrolled[0])).toBe(true);
    expect((scrolled[0] as HTMLElement).dataset.page).toBe("1");
  });

  it("fit 은 캔버스 폭 · 쪽 높이에 맞추고, 쪽 맞춤은 그 쪽으로 옮긴다", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const { ref, container } = mount(new MockAdapter({ pages: 2 }));
    await sheetOf(container);
    const h = ref.current!;
    // jsdom 은 배치를 하지 않는다 — 크기를 모르면 배율을 그대로 둔다
    expect(h.fit("width")).toBe(h.getZoom());
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 1207 });
    Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 579 });
    act(() => {
      h.fit("width");
    });
    expect(h.getZoom()).toBeCloseTo((1207 - 16) / 794, 6);
    scrolled.length = 0;
    act(() => {
      h.fit("page");
    });
    const pageView = createRef<PageViewHandle>();
    render(<HwpPageView adapter={new MockAdapter({ pages: 1 })} pageCount={1} handleRef={pageView} />);
    const size = pageView.current!.getPageSize(0)!;
    expect(h.getZoom()).toBeCloseTo(Math.min((1207 - 16) / 794, (579 - 16) / size.height), 6);
    expect(scrolled.some((el) => (el as HTMLElement).dataset.page === "0")).toBe(true);
  });
});

describe("WorkspaceHandle — 기록", () => {
  it("문서가 없으면 undo · redo 는 false 다", async () => {
    const ref = createRef<WorkspaceHandle>();
    render(<HwpWorkspace adapter={new MockAdapter({ pages: 1 })} onAiRequest={noAi} handleRef={ref} />);
    await expect(ref.current!.undo()).resolves.toBe(false);
    await expect(ref.current!.redo()).resolves.toBe(false);
  });

  it("undo · redo · canUndo · canRedo 가 세션 기록과 같고 history 를 알린다", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const { ref, container, api } = mount(adapter);
    await sheetOf(container);
    const h = ref.current!;
    const seen: WorkspaceHandleChange[] = [];
    h.subscribe((c) => seen.push(c));
    expect(h.canUndo()).toBe(false);
    await act(async () => {
      await api()!.apply([{ intent: "SetParagraphText", section: 0, block: 0, text: "x" } as Intent]);
    });
    expect(h.canUndo()).toBe(true);
    let ok = false;
    await act(async () => {
      ok = await h.undo();
    });
    expect(ok).toBe(true);
    expect(adapter.undos).toBe(1);
    expect(h.canRedo()).toBe(true);
    await act(async () => {
      ok = await h.redo();
    });
    expect(ok).toBe(true);
    expect(adapter.redos).toBe(1);
    expect(h.canRedo()).toBe(false);
    expect(seen.filter((c) => c.history).length).toBe(3); // 적용 · 되돌리기 · 다시 실행
  });
});

describe("WorkspaceHandle — 서식", () => {
  const PAGE_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="794" height="1123">` +
    `<rect x="0" y="0" width="794" height="1123" fill="#FFFFFF"/>` +
    `<text x="100.00" y="50.00" font-size="13.00" font-family="NanumGothic, sans-serif" fill="#000000">가</text>` +
    `<text x="113.00" y="50.00" font-size="13.00" font-family="NanumGothic, sans-serif" fill="#000000">나</text>` +
    `<text x="130.00" y="50.00" font-size="13.00" font-family="NanumGothic, sans-serif" fill="#000000">다</text>` +
    `</svg>`;
  const BAND: BlockHit = { section: 0, block: 3, kind: "paragraph", x: 75, y: 40, w: 20, h: 20, text: "가나 다", editable: true };
  const bodyAdapter = (runs: RunSpec[]) =>
    new MockAdapter({ svg: () => PAGE_SVG, hit: (_p, _x, y) => (y >= 40 && y <= 60 ? BAND : null), blocks: [BAND], runs });
  const click = (el: Element, x: number, y: number) => {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1 });
  };

  it("캐럿이 없으면 toggleStyle 은 false 이고 아무것도 쓰지 않는다", async () => {
    const adapter = bodyAdapter([{ text: "가나 다" }]);
    const { ref, container } = mount(adapter, { enableEditing: true });
    await sheetOf(container);
    await expect(ref.current!.toggleStyle("underline")).resolves.toBe(false);
    expect(adapter.applied).toHaveLength(0);
  });

  it("toggleStyle 은 ⌘U 와 같은 Intent 를 낸다(캐럿 선택 범위만)", async () => {
    const viaKey = bodyAdapter([{ text: "가나 다" }]);
    const k = mount(viaKey, { enableEditing: true });
    click(await sheetOf(k.container), 101, 45);
    await waitFor(() => expect(k.container.querySelector(".hw-caret")).toBeTruthy());
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await flush();
    fireEvent.keyDown(window, { key: "u", metaKey: true });
    await waitFor(() => expect(viaKey.applied).toHaveLength(1));
    k.unmount();

    const viaHandle = bodyAdapter([{ text: "가나 다" }]);
    const h = mount(viaHandle, { enableEditing: true });
    click(await sheetOf(h.container), 101, 45);
    await waitFor(() => expect(h.container.querySelector(".hw-caret")).toBeTruthy());
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await flush();
    let ok = false;
    await act(async () => {
      ok = await h.ref.current!.toggleStyle("underline");
    });
    expect(ok).toBe(true);
    expect(viaHandle.applied).toEqual(viaKey.applied);
    expect(viaHandle.applied[0]).toMatchObject({ intent: "SetParagraphRuns", runs: [{ text: "가나 다", underline: true }] });
  });

  it("편집 정책이 거절하면 toggleStyle 은 false 이고 문서는 그대로다", async () => {
    const adapter = bodyAdapter([{ text: "가나 다" }]);
    const { ref, container } = mount(adapter, { enableEditing: true, onBeforeApply: () => false });
    click(await sheetOf(container), 101, 45);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    await flush();
    let ok = true;
    await act(async () => {
      ok = await ref.current!.toggleStyle("bold");
    });
    expect(ok).toBe(false);
    expect(adapter.applied).toHaveLength(0);
  });

  it("getSelectionFormat 은 밑줄 · 글자 배경 · 섞임을 준다", async () => {
    const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };
    const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 3, text: "칸", x: 140, y: 100, w: 100, h: 40 };
    const runs: RunSpec[] = [
      { text: "형광", underline: true, highlight: "#FFF2A8" },
      { text: " 보통" },
    ];
    const adapter = new MockAdapter({ table, cell, runs, colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { ref, container } = mount(adapter, { enableEditing: true });
    const sheet = await sheetOf(container);
    expect(ref.current!.getSelectionFormat()).toBeNull();
    const seen: WorkspaceHandleChange[] = [];
    ref.current!.subscribe((c) => seen.push(c));
    // 셀 드릴 = 두 번 클릭
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
      fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    }
    await waitFor(() => expect(ref.current!.getSelectionFormat()?.underline).toBe(true));
    expect(ref.current!.getSelectionFormat()).toMatchObject({
      underline: true,
      highlight: "#FFF2A8",
      mixed: { underline: true, highlight: true },
    });
    expect(seen.some((c) => c.selection)).toBe(true);
  });
});

describe("chrome — 호스트가 그리는 크롬은 DOM 에 없다", () => {
  it("기본은 셋 다 그린다", async () => {
    const { container } = mount(new MockAdapter({ pages: 2, outline: [] }));
    await sheetOf(container);
    expect(container.querySelector(".hw-toolbar")).toBeTruthy();
    expect(container.querySelector('[data-testid="hw-outline"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="hw-statusbar-page"]')).toBeTruthy();
  });

  it("셋을 끄면 셋 다 없고 캔버스 · 쪽은 그대로다", async () => {
    const { container, ref } = mount(new MockAdapter({ pages: 2, outline: [] }), {
      chrome: { toolbar: false, outline: false, statusBar: false },
    });
    await sheetOf(container);
    expect(container.querySelector(".hw-toolbar")).toBeNull();
    expect(container.querySelector('[data-testid="hw-outline"]')).toBeNull();
    expect(container.querySelector('[data-testid="hw-statusbar-page"]')).toBeNull();
    expect(container.querySelector(".hw-canvas .hw-sheet svg")).toBeTruthy();
    expect(ref.current!.getPage().count).toBe(2); // 상태 막대가 없어도 핸들로 읽는다
  });
});

describe("PageViewHandle", () => {
  it("scrollToPage 는 그 쪽 틀을 밀고, 범위 밖 쪽은 무시한다 · getPageSize 는 배율 1 의 CSS px", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const ref = createRef<PageViewHandle>();
    const { container } = render(<HwpPageView adapter={new MockAdapter({ pages: 2 })} pageCount={2} zoom={1.5} handleRef={ref} />);
    await sheetOf(container, 1);
    ref.current!.scrollToPage(1);
    ref.current!.scrollToPage(5);
    expect(scrolled.map((el) => (el as HTMLElement).dataset.page)).toEqual(["1"]);
    expect(ref.current!.getPageSize(0)?.width).toBe(794); // 배율(1.5)과 무관
    expect(ref.current!.getPageSize(2)).toBeNull();
  });
});

describe("onReady · useWorkspaceState — react 층", () => {
  it("onReady 는 마운트마다 한 번(StrictMode 에서도) handleRef 와 같은 핸들로 부르고, 함수 · 배율이 바뀌어도 다시 부르지 않는다", async () => {
    const ref = createRef<WorkspaceHandle>();
    const seen: WorkspaceHandle[] = [];
    const adapter = new MockAdapter({ pages: 1 });
    const tree = (tag: string) => (
      <StrictMode>
        <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} handleRef={ref} className={tag} onReady={(h) => seen.push(h)} />
      </StrictMode>
    );
    const { container, rerender } = render(tree("a"));
    await sheetOf(container);
    rerender(tree("b"));
    act(() => {
      ref.current!.setZoom(0.75);
    });
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(ref.current);
  });

  it("useWorkspaceState 는 onReady 로 받은 핸들의 값을 그리고, 보이는 값이 그대로인 알림에는 새 값을 내지 않는다", async () => {
    const box: { ws: WorkspaceHandle | null; panel: WorkspaceSidePanel | null } = { ws: null, panel: null };
    let commits = 0;
    function Host({ adapter }: { adapter: MockAdapter }) {
      const [ws, setWs] = useState<WorkspaceHandle | null>(null);
      const view = useWorkspaceState(ws);
      useEffect(() => {
        commits += 1;
      }, [view]);
      return (
        <div>
          <span data-testid="host-view">{view ? `${Math.round(view.zoom * 100)}% ${view.page + 1}/${view.pageCount} undo:${view.canUndo}` : "-"}</span>
          <HwpWorkspace
            adapter={adapter}
            document={doc}
            onAiRequest={noAi}
            onReady={(h) => {
              box.ws = h;
              setWs(h);
            }}
            sidePanel={(api) => {
              box.panel = api;
              return null;
            }}
          />
        </div>
      );
    }
    const { container, getByTestId } = render(<Host adapter={new MockAdapter({ pages: 3 })} />);
    await sheetOf(container);
    await waitFor(() => expect(getByTestId("host-view").textContent).toBe("90% 1/3 undo:false"));
    act(() => {
      box.ws!.setZoom(1.5);
    });
    await waitFor(() => expect(getByTestId("host-view").textContent).toBe("150% 1/3 undo:false"));
    await act(async () => {
      await box.panel!.apply([{ intent: "SetParagraphText", section: 0, block: 0, text: "x" } as Intent]);
    });
    await waitFor(() => expect(getByTestId("host-view").textContent).toBe("150% 1/3 undo:true"));
    // 두 번째 편집 — 기록 깊이가 1 → 2 라 history 알림은 오지만, 보이는 값(배율 · 쪽 · canUndo · canRedo)은 그대로다
    let notified = 0;
    const off = box.ws!.subscribe(() => {
      notified += 1;
    });
    const before = commits;
    await act(async () => {
      await box.panel!.apply([{ intent: "SetParagraphText", section: 0, block: 0, text: "y" } as Intent]);
    });
    await flush();
    off();
    expect(notified).toBeGreaterThan(0); // 알림은 왔다 — 이 단언이 없으면 아래 단언이 공허하다
    expect(commits).toBe(before);
    expect(getByTestId("host-view").textContent).toBe("150% 1/3 undo:true");
  });

  it("useWorkspaceState — 핸들이 없으면 null, 값이 같은 새 서식 객체는 무시하고 바뀐 값만 내며, 언마운트하면 구독을 푼다", () => {
    const listeners = new Set<(c: WorkspaceHandleChange) => void>();
    let zoom = 1;
    let fmt: WorkspaceTextFormat = { font: "A", sizePt: 10, color: null, bold: false, italic: false, underline: false, highlight: null };
    const fake = {
      getZoom: () => zoom,
      getPage: () => ({ current: 0, count: 2 }),
      canUndo: () => false,
      canRedo: () => false,
      getSelectionFormat: () => fmt,
      subscribe: (l: (c: WorkspaceHandleChange) => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
    } as unknown as WorkspaceHandle;
    const emit = (c: WorkspaceHandleChange) =>
      act(() => {
        listeners.forEach((l) => l(c));
      });
    let commits = 0;
    function Probe({ handle }: { handle: WorkspaceHandle | null }) {
      const v = useWorkspaceState(handle);
      useEffect(() => {
        commits += 1;
      }, [v]);
      return <span data-testid="probe">{v ? `${v.zoom} ${v.format?.bold}` : "-"}</span>;
    }
    const { getByTestId, rerender, unmount } = render(<Probe handle={null} />);
    expect(getByTestId("probe").textContent).toBe("-");
    rerender(<Probe handle={fake} />);
    expect(getByTestId("probe").textContent).toBe("1 false");
    expect(listeners.size).toBe(1);
    const before = commits;
    fmt = { ...fmt }; // 새 객체, 같은 값
    emit({ selection: true });
    expect(commits).toBe(before);
    fmt = { ...fmt, bold: true, mixed: { italic: true } };
    emit({ selection: true });
    expect(getByTestId("probe").textContent).toBe("1 true");
    zoom = 2;
    emit({ zoom: true });
    expect(getByTestId("probe").textContent).toBe("2 true");
    unmount();
    expect(listeners.size).toBe(0);
  });
});
