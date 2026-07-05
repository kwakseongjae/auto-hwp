import { describe, expect, it } from "vitest";
import { DocSession } from "../session";
import { FindController } from "../find";
import { createEditorCore } from "../core";
import type { CaretRect, FindMatch } from "../types";
import { MockAdapter } from "./mockAdapter";

/// FindController (issue 045) — the headless 찾기/바꾸기 engine: cursor cycling / boundaries / empty query /
/// caretRect-derived geometry / replace + undo coherence, all node-tested against the MockAdapter.

const M = (over: Partial<FindMatch> = {}): FindMatch => ({ node: 1, start: 0, len: 2, section: 0, block: 0, ...over });

function controller(opts: ConstructorParameters<typeof MockAdapter>[0]) {
  const adapter = new MockAdapter(opts);
  const session = new DocSession(adapter);
  return { adapter, session, find: new FindController(adapter, session) };
}

describe("FindController — search + cursor", () => {
  it("search stores matches, sets cursor to the first, and reports n/m", async () => {
    const { find } = controller({ find: [M({ start: 0 }), M({ start: 5 }), M({ start: 9 })] });
    const ms = await find.search("가", { caseSensitive: false });
    expect(ms).toHaveLength(3);
    expect(find.count).toBe(3);
    expect(find.cursor).toBe(0);
    expect(find.ordinal).toBe(1);
    expect(find.current).toEqual(M({ start: 0 }));
  });

  it("an empty query clears matches WITHOUT hitting the engine", async () => {
    const { adapter, find } = controller({ find: [M()] });
    await find.search("");
    expect(find.count).toBe(0);
    expect(find.cursor).toBe(-1);
    expect(find.ordinal).toBe(0);
    expect(adapter.finds).toHaveLength(0); // no engine call for an empty query
  });

  it("next/prev cycle with wrap-around at both boundaries", async () => {
    const { find } = controller({ find: [M({ start: 0 }), M({ start: 5 }), M({ start: 9 })] });
    await find.search("가");
    expect(find.cursor).toBe(0);
    find.next();
    expect(find.cursor).toBe(1);
    find.next();
    find.next(); // 2 → wraps to 0
    expect(find.cursor).toBe(0);
    find.prev(); // 0 → wraps to 2
    expect(find.cursor).toBe(2);
    expect(find.ordinal).toBe(3);
  });

  it("next/prev on zero matches is a graceful null (no crash, cursor stays -1)", async () => {
    const { find } = controller({ find: [] });
    await find.search("없음");
    expect(find.count).toBe(0);
    expect(find.next()).toBeNull();
    expect(find.prev()).toBeNull();
    expect(find.cursor).toBe(-1);
  });

  it("supported/canLocate reflect the backend capabilities", async () => {
    const withAll = controller({ find: [M()], caret: { x: 1, top: 1, height: 1 } });
    expect(withAll.find.supported).toBe(true);
    expect(withAll.find.canLocate).toBe(true);
    const noFind = controller({}); // find omitted → unsupported
    expect(noFind.find.supported).toBe(false);
    const noCaret = controller({ find: [M()] }); // caret omitted → count/nav only
    expect(noCaret.find.supported).toBe(true);
    expect(noCaret.find.canLocate).toBe(false);
  });

  it("refresh re-runs the current query and clamps the cursor to the new count", async () => {
    // A resolver that shrinks the result set the SECOND time it is called (simulates a post-edit re-find).
    let calls = 0;
    const { find } = controller({
      find: () => (++calls === 1 ? [M({ start: 0 }), M({ start: 5 }), M({ start: 9 })] : [M({ start: 0 })]),
    });
    await find.search("가");
    find.next();
    find.next(); // cursor = 2
    await find.refresh();
    expect(find.count).toBe(1);
    expect(find.cursor).toBe(0); // clamped from 2 → 0 (new max index)
  });
});

describe("FindController — geometry (caretRect resolution, no new engine query)", () => {
  // node 1 renders on page 0; a caret at `start` is at x=100, at `start+len` at x=130, same line (top 50).
  const caret = (page: number, node: number, offset: number): CaretRect | null => {
    if (page !== (node === 2 ? 2 : 0)) return null; // node 2 lives on page 2, node 1 on page 0
    return { x: 100 + offset * 6, top: 50, height: 12 };
  };

  it("locate brackets a match into a single-line box on its own page", async () => {
    const { find } = controller({ find: [M({ node: 1, start: 0, len: 5 })], caret, pages: 3 });
    await find.search("hello");
    const box = await find.locate(find.current!, 3);
    expect(box).toEqual({ page: 0, box: { x: 100, y: 50, w: 30, h: 12 } }); // 130-100 = 30 wide
  });

  it("locate probes forward to the page the match renders on", async () => {
    const { find } = controller({ find: [M({ node: 2, start: 0, len: 2 })], caret, pages: 3 });
    await find.search("가");
    const box = await find.locate(find.current!, 3);
    expect(box?.page).toBe(2);
  });

  it("locate returns null when the backend omits caretRect (하이라이트 스코프 축소 fallback)", async () => {
    const { find } = controller({ find: [M()] }); // no caret → canLocate false
    await find.search("가");
    expect(await find.locate(find.current!, 3)).toBeNull();
  });

  it("locate swallows a caretRect REJECTION to null (edited doc: rhwp render gone — never crashes search)", async () => {
    const { find } = controller({
      find: [M()],
      caret: () => {
        throw new Error("원본(SVG) 렌더는 편집 전 문서에만 제공됩니다");
      },
    });
    await find.search("가");
    expect(await find.locate(find.current!, 3)).toBeNull();
    // locateAll must also survive the rejection (returns index-aligned nulls, not a throw).
    await expect(find.locateAll(3)).resolves.toEqual([null]);
  });

  it("locateAll returns index-aligned boxes for every match", async () => {
    const { find } = controller({ find: [M({ node: 1, start: 0, len: 2 }), M({ node: 2, start: 3, len: 2 })], caret, pages: 3 });
    await find.search("가");
    const boxes = await find.locateAll(3);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.page).toBe(0);
    expect(boxes[1]?.page).toBe(2);
  });
});

describe("FindController — replace + undo coherence", () => {
  it("replaceCurrent calls the adapter with all:false and records ONE undo unit", async () => {
    const { adapter, session, find } = controller({ find: [M(), M({ start: 5 })], pages: 2 });
    await session.open(new Uint8Array([1]), "t.hwpx");
    await find.search("가");
    const res = await find.replaceCurrent("나");
    expect(res.replaced).toBe(1);
    expect(adapter.replaces).toHaveLength(1);
    expect(adapter.replaces[0]).toMatchObject({ query: "가", replacement: "나", opts: { all: false } });
    expect(session.canUndo()).toBe(true); // recordExternalEdit pushed a batch
  });

  it("propagates the search options (case-sensitivity) into the replace call", async () => {
    const { adapter, session, find } = controller({ find: [M()], pages: 1 });
    await session.open(new Uint8Array([1]), "t.hwpx");
    await find.search("가", { caseSensitive: true, wholeWord: true });
    await find.replaceAll("나");
    expect(adapter.replaces[0].opts).toMatchObject({ caseSensitive: true, wholeWord: true, all: true });
  });

  it("replaceAll replaces every match as ONE undo unit; session.undo reverts it with one adapter.undo", async () => {
    const { adapter, session, find } = controller({ find: [M(), M({ start: 5 }), M({ start: 9 })], pages: 2 });
    await session.open(new Uint8Array([1]), "t.hwpx");
    await find.search("가");
    const res = await find.replaceAll("나");
    expect(res.replaced).toBe(3);
    expect(adapter.replaces[0].opts.all).toBe(true);
    expect(session.canUndo()).toBe(true);
    // ONE undo unit: a single session.undo → exactly one adapter.undo (replace-all is one do_ops).
    const undone = await session.undo();
    expect(undone).toBe(true);
    expect(adapter.undos).toBe(1);
    expect(session.canUndo()).toBe(false);
  });

  it("a 0-count replace is a no-op — no undo unit, no re-flow (040 no-op guard)", async () => {
    const { session, find } = controller({ find: [], pages: 2 });
    await session.open(new Uint8Array([1]), "t.hwpx");
    await find.search("없음");
    const res = await find.replaceAll("나");
    expect(res.replaced).toBe(0);
    expect(session.canUndo()).toBe(false); // nothing replaced → no undo unit
  });

  it("replace without a query does nothing", async () => {
    const { adapter, session, find } = controller({ find: [M()], pages: 1 });
    await session.open(new Uint8Array([1]), "t.hwpx");
    const res = await find.replaceCurrent("나");
    expect(res).toEqual({ replaced: 0, pages: 0 });
    expect(adapter.replaces).toHaveLength(0);
  });
});

describe("EditorCore wiring", () => {
  it("exposes a FindController at core.find", () => {
    const core = createEditorCore(new MockAdapter({ find: [M()] }));
    expect(core.find).toBeInstanceOf(FindController);
  });
});
