import { describe, expect, it, vi } from "vitest";
import type { OutlineItem } from "../types";

// Issue 046 — the outline query is HOMOMORPHIC across the two backends (043 pattern): the WasmAdapter maps
// it onto the engine `outline()` binding and the TauriAdapter onto the desktop `doc_outline` command, and
// BOTH return the SAME `OutlineItem[]` shape with the SAME empty-array-on-none policy (018). These tests
// pin each seam so HwpWorkspace runs identically on the web and the new-shell desktop.

const ITEMS: OutlineItem[] = [
  { section: 0, block: 0, level: 1, text: "□ 개요", page: 0 },
  { section: 0, block: 6, level: 2, text: "1. 문제 인식 및 필요성", page: 3 },
];

// ── WasmAdapter → engine.outline() ────────────────────────────────────────────────────────────────────
// A minimal @tf-hwp/engine mock: HwpDoc.open returns a fake doc whose outline() yields the canned items
// (mirroring the wasm binding's JSON→array unwrap). Proves the adapter forwards the engine result verbatim.
vi.mock("@tf-hwp/engine", () => {
  class HwpDoc {
    static open() {
      return new HwpDoc();
    }
    pageCount() {
      return ITEMS.length + 1;
    }
    outline() {
      return ITEMS;
    }
    free() {}
  }
  return { HwpDoc, initEngine: async () => {}, resetEngine: async () => {} };
});

describe("WasmAdapter.outline (issue 046)", () => {
  it("delegates to the engine outline() binding and returns OutlineItem[] verbatim", async () => {
    const { WasmAdapter } = await import("../WasmAdapter");
    const a = new WasmAdapter();
    await a.open(new Uint8Array([1]), "doc.hwpx");
    await expect(a.outline()).resolves.toEqual(ITEMS);
  });
});

// ── TauriAdapter → doc_outline command ────────────────────────────────────────────────────────────────
describe("TauriAdapter.outline (issue 046)", () => {
  it("maps to the doc_outline command and passes the OutlineItem[] through (no args)", async () => {
    const { TauriAdapter } = await import("../TauriAdapter");
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return ITEMS as unknown;
    }) as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    const a = new TauriAdapter({ invoke });
    await expect(a.outline()).resolves.toEqual(ITEMS);
    expect(calls).toEqual([{ cmd: "doc_outline", args: undefined }]);
  });

  it("passes an empty desktop result through as [] (018 — never null)", async () => {
    const { TauriAdapter } = await import("../TauriAdapter");
    const invoke = (async () => []) as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    const a = new TauriAdapter({ invoke });
    await expect(a.outline()).resolves.toEqual([]);
  });
});
