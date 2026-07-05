import { describe, expect, it, vi } from "vitest";
import { TauriAdapter } from "../TauriAdapter";

// Issue 045 — the TauriAdapter find/replace mapping onto the desktop `find_text`/`replace_text` commands
// (the SAME op-bus `do_find`/`do_replace` the wasm `Find`/`Replace` Intents drive, so 동형 파리티). The
// WasmAdapter path (applyIntent Find/Replace JSON) is proven end-to-end against the real engine by
// scripts/find-geometry-smoke.mjs; here we lock the desktop command names + camelCase param keys + the
// verbatim DTO passthrough (FindMatch/ReplaceResult match the command DTOs 1:1 — no remap).

describe("TauriAdapter.find / replace (issue 045)", () => {
  it("find invokes find_text with camelCase opts and passes the matches through verbatim", async () => {
    const matches = [{ node: 16, start: 120, len: 1, section: 0, block: 21 }];
    const invoke = vi.fn().mockResolvedValue(matches);
    const a = new TauriAdapter({ invoke });
    const out = await a.find!("이", { caseSensitive: true, wholeWord: false });
    expect(invoke).toHaveBeenCalledWith("find_text", { query: "이", caseSensitive: true, wholeWord: false });
    expect(out).toEqual(matches); // FindMatchDto (node/start/len/section/block) == FindMatch, no remap
  });

  it("find coerces undefined opts to false (default case-insensitive, substring)", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const a = new TauriAdapter({ invoke });
    await a.find!("가", {});
    expect(invoke).toHaveBeenCalledWith("find_text", { query: "가", caseSensitive: false, wholeWord: false });
  });

  it("replace invokes replace_text with all:false and returns {replaced, pages} verbatim", async () => {
    const invoke = vi.fn().mockResolvedValue({ replaced: 1, pages: 25 });
    const a = new TauriAdapter({ invoke });
    const res = await a.replace!("이", "그", { caseSensitive: false, all: false });
    expect(invoke).toHaveBeenCalledWith("replace_text", {
      query: "이",
      replacement: "그",
      caseSensitive: false,
      wholeWord: false,
      all: false,
    });
    expect(res).toEqual({ replaced: 1, pages: 25 });
  });

  it("replace-all forwards all:true (one undo unit on the engine side)", async () => {
    const invoke = vi.fn().mockResolvedValue({ replaced: 73, pages: 24 });
    const a = new TauriAdapter({ invoke });
    const res = await a.replace!("이", "그", { caseSensitive: true, wholeWord: true, all: true });
    expect(invoke).toHaveBeenCalledWith("replace_text", {
      query: "이",
      replacement: "그",
      caseSensitive: true,
      wholeWord: true,
      all: true,
    });
    expect(res.replaced).toBe(73);
  });
});
