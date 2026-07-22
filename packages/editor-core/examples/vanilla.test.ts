import { describe, expect, it } from "vitest";
import { runVanillaDemo } from "./vanilla";

// The "React-free" contract proof (issue 026 step 6): the vanilla example must drive the whole
// open → select cell → apply intent → undo → export flow with NO React and NO DOM. If this passes in a
// pure node environment, a host can embed auto-hwp in any framework (or none).
describe("examples/vanilla.ts — headless end-to-end (no React/DOM)", () => {
  it("open → cell select → intent apply → export → undo, driving editor-core directly", async () => {
    const { log, html, undoHtml } = await runVanillaDemo();

    // The document opened and a single cell was selected via a pure pointer input.
    expect(log.some((l) => l.startsWith("doc:") && l.includes("hwpx"))).toBe(true);
    expect(log.some((l) => l.startsWith("selection: 1") && l.includes("행"))).toBe(true);

    // The AI's Intent previewed as a "칸 채우기" card and applied one op.
    expect(log).toContain("preview: 칸 채우기");
    expect(log).toContain("applied: 1 op(s)");

    // The exported HTML reflects the applied edit; undo rolls it back.
    expect(html).toContain("사업 개요를 채운다");
    expect(undoHtml).not.toContain("사업 개요를 채운다");
    expect(undoHtml).toContain("미작성");
  });
});
