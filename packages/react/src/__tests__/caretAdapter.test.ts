import { describe, expect, it, vi } from "vitest";
import { TauriAdapter } from "../TauriAdapter";

// Issue 041 — the TauriAdapter glyph-caret mapping has REAL logic (the desktop `hit_test` command
// answers in camelCase; `hitTestText` remaps it into editor-core's snake_case `HitResult`), so lock it
// down with a mock `invoke`. The WasmAdapter path is proven end-to-end by scripts/caret-geometry-smoke.mjs
// (it needs the wasm engine); the editor-core caret.test.ts covers the pure model + null policy.

describe("TauriAdapter.hitTestText / caretRect (issue 041)", () => {
  it("remaps the desktop hit_test camelCase DTO into snake_case HitResult", async () => {
    const invoke = vi.fn().mockResolvedValue({
      node: 5,
      block: 2,
      offset: 7,
      section: 0,
      paraOrd: 3,
      inCell: false,
      paraLen: 20,
    });
    const a = new TauriAdapter({ invoke });
    const hit = await a.hitTestText!(0, 100, 200);
    expect(invoke).toHaveBeenCalledWith("hit_test", { page: 0, x: 100, y: 200 });
    expect(hit).toEqual({
      node: 5,
      block: 2,
      offset: 7,
      section: 0,
      para_ord: 3, // camelCase paraOrd → snake_case para_ord
      in_cell: false,
      para_len: 20,
    });
  });

  it("passes through a null hit_test (018 null policy — off any glyph)", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const a = new TauriAdapter({ invoke });
    expect(await a.hitTestText!(0, 0, 0)).toBeNull();
  });

  it("forwards caretRect verbatim (the command DTO already matches {x, top, height})", async () => {
    const rect = { x: 120, top: 90, height: 13 };
    const invoke = vi.fn().mockResolvedValue(rect);
    const a = new TauriAdapter({ invoke });
    expect(await a.caretRect!(1, 5, 7)).toEqual(rect);
    expect(invoke).toHaveBeenCalledWith("caret_rect", { page: 1, node: 5, offset: 7 });
  });

  it("returns null from caretRect when the paragraph is not on the page", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const a = new TauriAdapter({ invoke });
    expect(await a.caretRect!(9, 5, 7)).toBeNull();
  });
});
