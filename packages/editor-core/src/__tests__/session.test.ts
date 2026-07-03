import { describe, expect, it } from "vitest";
import { createEditorCore } from "../core";
import { DocSession } from "../session";
import type { Intent, OpenResult } from "../types";
import { MockAdapter } from "./mockAdapter";

describe("DocSession — lifecycle / undo / font (issue 026)", () => {
  it("open sets meta, resets stacks, and emits docChange + layoutInvalidated", async () => {
    const s = new DocSession(new MockAdapter({ pages: 3 }));
    const seen: (OpenResult | null)[] = [];
    let invalidated = 0;
    s.onDocChange((m) => seen.push(m));
    s.onLayoutInvalidated(() => invalidated++);
    const r = await s.open(new Uint8Array([1]), "t.hwpx");
    expect(r.pages).toBe(3);
    expect(seen[seen.length - 1]?.pages).toBe(3);
    expect(s.pages).toBe(3);
    expect(s.editable).toBe(true);
    expect(invalidated).toBe(1);
    expect(s.canUndo()).toBe(false);
  });

  it("applyBatch applies each intent, records ONE undo batch, and re-queries pages", async () => {
    const adapter = new MockAdapter({ pages: 2 });
    const s = new DocSession(adapter);
    await s.open(new Uint8Array([1]), "t.hwpx");
    const intents: Intent[] = [
      { intent: "SetParagraphText", section: 0, block: 2, text: "새 문단" },
      { intent: "SetParagraphText", section: 0, block: 3, text: "또 하나" },
    ];
    const n = await s.applyBatch(intents);
    expect(n).toBe(2);
    expect(adapter.applied).toHaveLength(2);
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);
  });

  it("undo replays the whole batch (N adapter.undo calls) and enables redo", async () => {
    const adapter = new MockAdapter({ pages: 2 });
    const s = new DocSession(adapter);
    await s.open(new Uint8Array([1]), "t.hwpx");
    await s.applyBatch([
      { intent: "SetParagraphText", section: 0, block: 2, text: "a" },
      { intent: "SetParagraphText", section: 0, block: 3, text: "b" },
    ]);
    await s.undo();
    expect(adapter.undos).toBe(2); // the 2-op batch undone as one unit
    expect(s.canRedo()).toBe(true);
    await s.redo();
    expect(adapter.redos).toBe(2);
  });

  it("registerFont registers the face, tracks the family, and invalidates layout", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const s = new DocSession(adapter);
    await s.open(new Uint8Array([1]), "t.hwpx");
    let invalidated = 0;
    s.onLayoutInvalidated(() => invalidated++);
    await s.registerFont("Nanum Gothic", new Uint8Array([0, 1, 0, 0]));
    expect(adapter.registeredFonts[0].family).toBe("Nanum Gothic");
    expect(s.getFontFamily()).toBe("Nanum Gothic");
    expect(invalidated).toBe(1);
  });

  it("docContext folds doc meta + the given anchors", async () => {
    const s = new DocSession(new MockAdapter({ pages: 5 }));
    await s.open(new Uint8Array([1]), "plan.hwpx");
    const ctx = s.docContext([{ kind: "cell", section: 0, block: 1, rows: [0, 0], cols: [0, 0], label: "표 1행 1열", page: 0, text: "x" }]);
    expect(ctx).toMatchObject({ format: "hwpx", editable: true, sections: 1, pages: 5 });
    expect(ctx.anchors).toHaveLength(1);
  });
});

describe("EditController — assemble + apply (issue 026)", () => {
  it("apply commits the batch through the session AND clears the consumed selection", async () => {
    const adapter = new MockAdapter({ pages: 1, hit: { section: 0, block: 2, kind: "paragraph", x: 0, y: 0, w: 100, h: 20, text: "결론", editable: true } });
    const core = createEditorCore(adapter);
    await core.session.open(new Uint8Array([1]), "t.hwpx");
    // Mark a block via the selection model, then apply — the controller should clear it after commit.
    await core.selection.pointerDown({ page: 0, x: 10, y: 10, mod: false });
    await core.selection.pointerUp();
    expect(core.selection.getSelection()).toHaveLength(1);
    const cards = core.edit.preview([{ intent: "SetParagraphText", section: 0, block: 2, text: "새" }]);
    expect(cards[0]).toMatchObject({ kind: "SetParagraphText", label: "문단 수정" });
    const n = await core.edit.apply([{ intent: "SetParagraphText", section: 0, block: 2, text: "새" }]);
    expect(n).toBe(1);
    expect(adapter.applied).toHaveLength(1);
    expect(core.selection.getSelection()).toHaveLength(0); // consumed
  });

  it("docContext() reflects the live selection anchors", async () => {
    const core = createEditorCore(new MockAdapter({ pages: 1, hit: { section: 0, block: 4, kind: "paragraph", x: 0, y: 0, w: 100, h: 20, text: "문단", editable: true } }));
    await core.session.open(new Uint8Array([1]), "t.hwpx");
    await core.selection.pointerDown({ page: 0, x: 5, y: 5, mod: false });
    await core.selection.pointerUp();
    const ctx = core.edit.docContext();
    expect(ctx.anchors).toHaveLength(1);
    expect(ctx.anchors[0].block).toBe(4);
  });
});
