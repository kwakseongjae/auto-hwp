import { describe, expect, it } from "vitest";
import { fileType, pageCountBucket } from "./analytics";

describe("workspace analytics privacy buckets", () => {
  it("reduces filenames to a finite file type", () => {
    expect(fileType("민감한 사업계획서.HWP")).toBe("hwp");
    expect(fileType("people.hwpx")).toBe("hwpx");
    expect(fileType("secret.pdf")).toBe("unknown");
  });

  it("buckets page counts instead of sending continuous values", () => {
    expect(pageCountBucket(undefined)).toBe("unknown");
    expect(pageCountBucket(1)).toBe("1");
    expect(pageCountBucket(8)).toBe("6-10");
    expect(pageCountBucket(25)).toBe("11-25");
    expect(pageCountBucket(51)).toBe("51+");
  });
});
