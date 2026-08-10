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

  // ── caret-undo 증상 4: 배치 원자성 ────────────────────────────────────────────────────────────────
  // 실측(sample-8p, 표 채우기): 2건 중 2번째가 병합 셀에 걸려 엔진이 거절 → 1번째는 이미 커밋됐는데
  // undo 장부에는 아무 배치도 안 남아, "적용 실패"라고 안내하면서 문서는 바뀌고, 이후 ⌘Z 는 그 고아
  // op 를 앞선 배치 몫으로 벗겨낸다. 실패한 배치는 스스로 롤백해 문서를 원상으로 남겨야 한다.
  /** 지정한 순번의 intent 에서 던지는 어댑터 — 부분 실패를 결정적으로 만든다. */
  class FailingAdapter extends MockAdapter {
    constructor(private failAt: number, opts: { pages?: number } = {}) {
      super(opts);
    }
    override async applyIntent(intent: Intent) {
      if (this.applied.length === this.failAt) throw new Error("SetTableCell: no active cell");
      return super.applyIntent(intent);
    }
  }

  it("a batch that fails PART WAY rolls back the ops that already landed (문서 원상)", async () => {
    const adapter = new FailingAdapter(2, { pages: 2 });
    const s = new DocSession(adapter);
    await s.open(new Uint8Array([1]), "t.hwpx");
    const intents: Intent[] = [
      { intent: "SetParagraphText", section: 0, block: 1, text: "a" },
      { intent: "SetParagraphText", section: 0, block: 2, text: "b" },
      { intent: "SetParagraphText", section: 0, block: 3, text: "c" },
    ];
    await expect(s.applyBatch(intents)).rejects.toThrow(/no active cell/);
    expect(adapter.applied).toHaveLength(2); // 2건은 엔진에 커밋됐고
    expect(adapter.undos).toBe(2); // 그 2건이 되돌려졌다
    expect(s.canUndo()).toBe(false); // 남은 고아 배치 없음 = ⌘Z 가 엉뚱한 편집을 벗기지 않는다
  });

  it("a failed batch never leaves an edit outside the undo bookkeeping (롤백 불가 시 배치로 기록)", async () => {
    class NoUndoAdapter extends FailingAdapter {
      override async undo(): Promise<boolean> {
        this.undos++;
        return false; // 엔진이 더 되돌릴 수 없다고 답한다
      }
    }
    const adapter = new NoUndoAdapter(1, { pages: 2 });
    const s = new DocSession(adapter);
    await s.open(new Uint8Array([1]), "t.hwpx");
    await expect(
      s.applyBatch([
        { intent: "SetParagraphText", section: 0, block: 1, text: "a" },
        { intent: "SetParagraphText", section: 0, block: 2, text: "b" },
      ]),
    ).rejects.toThrow();
    expect(adapter.applied).toHaveLength(1);
    expect(s.canUndo()).toBe(true); // 살아남은 1건은 한 번의 undo 로 닿을 수 있어야 한다
  });

  it("an EMPTY proposal records no phantom batch (⌘Z 가 '아무것도 안 함'으로 소모되지 않게)", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const s = new DocSession(adapter);
    await s.open(new Uint8Array([1]), "t.hwpx");
    expect(await s.applyBatch([])).toBe(0);
    expect(s.canUndo()).toBe(false);
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
