import { describe, expect, it } from "vitest";
import {
  DESKTOP_DOCUMENTED_NOOPS,
  DESKTOP_EXPLICITLY_OFF,
  DESKTOP_INTENT_ROUTED_METHODS,
  DESKTOP_REQUIRED_METHODS,
} from "../desktopRequired";

describe("desktop-required method list (issue #64 D0)", () => {
  it("includes the three D0 methods and keeps adapter.ts optionality as a separate axis", () => {
    expect(DESKTOP_REQUIRED_METHODS).toContain("blockRunsPath");
    expect(DESKTOP_REQUIRED_METHODS).toContain("tableGrid");
    expect(DESKTOP_REQUIRED_METHODS).toContain("docProfile");
  });

  it("explicitly excludes normalize (not a silent omit) — core promotion is #65", () => {
    expect([...DESKTOP_EXPLICITLY_OFF].sort()).toEqual(["normalizeActive", "setNormalize"]);
    expect(DESKTOP_REQUIRED_METHODS).not.toContain("setNormalize");
    expect(DESKTOP_REQUIRED_METHODS).not.toContain("normalizeActive");
  });

  it("documents the two desktop no-ops and does not treat them as D0 gaps", () => {
    expect(DESKTOP_DOCUMENTED_NOOPS).toContain("registerFont");
    expect(DESKTOP_DOCUMENTED_NOOPS).toContain("dispose");
    for (const name of DESKTOP_DOCUMENTED_NOOPS) {
      expect(DESKTOP_REQUIRED_METHODS).toContain(name);
    }
  });

  it("routes the three D0 methods (and the existing cell-caret pair) through named Intents", () => {
    expect(DESKTOP_INTENT_ROUTED_METHODS.blockRunsPath).toBe("BlockRunsPath");
    expect(DESKTOP_INTENT_ROUTED_METHODS.tableGrid).toBe("TableGrid");
    expect(DESKTOP_INTENT_ROUTED_METHODS.docProfile).toBe("DocProfile");
    expect(DESKTOP_INTENT_ROUTED_METHODS.hitTestCellText).toBe("HitTestCell");
    expect(DESKTOP_INTENT_ROUTED_METHODS.caretRectCell).toBe("CaretRectCell");
  });
});
