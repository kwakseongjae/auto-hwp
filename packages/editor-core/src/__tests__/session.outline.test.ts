import { describe, expect, it } from "vitest";
import { DocSession } from "../session";
import type { OutlineItem } from "../types";
import { MockAdapter } from "./mockAdapter";

// Issue 046 — the document-outline read query on DocSession. A read-only facade over the OPTIONAL
// `adapter.outline` (both real backends answer with the SAME OutlineItem shape; a backend that can't OMITS
// it). No wasm, no DOM — the panel/status-bar rendering is exercised in @tf-hwp/react.
describe("DocSession.outline (issue 046)", () => {
  const items: OutlineItem[] = [
    { section: 0, block: 0, level: 1, text: "□ 개요", page: 0 },
    { section: 0, block: 4, level: 2, text: "1. 문제 인식", page: 2 },
  ];

  it("returns the adapter's outline verbatim when the backend answers", async () => {
    const s = new DocSession(new MockAdapter({ outline: items }));
    await expect(s.outline()).resolves.toEqual(items);
  });

  it("falls back to [] when the backend OMITS outline (never throws / never null)", async () => {
    // MockAdapter with no `outline` opt → the method is undefined (TauriAdapter-style omission).
    const s = new DocSession(new MockAdapter({}));
    await expect(s.outline()).resolves.toEqual([]);
  });

  it("returns [] for a document whose backend reports no heading (empty array, not null)", async () => {
    const s = new DocSession(new MockAdapter({ outline: [] }));
    await expect(s.outline()).resolves.toEqual([]);
  });
});
