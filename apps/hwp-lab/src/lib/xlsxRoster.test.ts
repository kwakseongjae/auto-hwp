import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXlsxRoster } from "./xlsxRoster";

const FIX = path.join(process.cwd(), "..", "..", "testdata", "roster");

describe("parseXlsxRoster — 073/#40 첫 시트 계약", () => {
  it("한글 헤더·셀 안 콤마·끝 빈 행", async () => {
    const rows = await parseXlsxRoster(readFileSync(path.join(FIX, "ok.xlsx")));
    expect(rows).toEqual([
      { 성명: "김하나", 기업명: "하나테크,본사" },
      { 성명: "이두리", 기업명: "두리소프트" },
    ]);
  });

  it("시트가 둘이면 조용히 첫 시트만 쓰지 않는다", async () => {
    await expect(parseXlsxRoster(readFileSync(path.join(FIX, "extra-sheet.xlsx")))).rejects.toThrow(/2개/);
  });

  it("병합 헤더는 정직 거부", async () => {
    await expect(parseXlsxRoster(readFileSync(path.join(FIX, "merged-header.xlsx")))).rejects.toThrow(/병합/);
  });
});
