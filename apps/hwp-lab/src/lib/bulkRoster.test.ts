import { describe, expect, it } from "vitest";
import { detectRosterFormat, parseRoster, readRoster } from "./bulkRoster";

// 명단 파서는 /bulk ③단계의 유일한 입력 관문 — 4형식 자동 감지와 "정직한 거부"를 잠근다.
// (퍼널 재설계에서 page.tsx → lib 로 옮겼다. 옮기기 전과 동치여야 하므로 오류 문구까지 본다.)
describe("parseRoster 4형식 자동 감지", () => {
  it("① JSON 배열", () => {
    expect(parseRoster('[{"성명":"김하나","연락처":"010-1234-5678"}]')).toEqual([{ 성명: "김하나", 연락처: "010-1234-5678" }]);
    expect(detectRosterFormat('[{"성명":"김하나"}]')).toBe("json");
  });

  it("② \"키: 값\" 블록 — 빈 줄이 인원 구분", () => {
    const rows = parseRoster("성명: 김하나\n연락처: 010-1111-2222\n\n성명: 이두리\n연락처: 010-3333-4444\n");
    expect(rows).toEqual([
      { 성명: "김하나", 연락처: "010-1111-2222" },
      { 성명: "이두리", 연락처: "010-3333-4444" },
    ]);
    expect(detectRosterFormat("성명: 김하나")).toBe("block");
  });

  it("③ TSV(엑셀 복사 붙여넣기)", () => {
    expect(parseRoster("성명\t연락처\n김하나\t010-1111-2222")).toEqual([{ 성명: "김하나", 연락처: "010-1111-2222" }]);
    expect(detectRosterFormat("성명\t연락처\n김하나\t010")).toBe("tsv");
  });

  it("④ CSV", () => {
    expect(parseRoster("성명,연락처\n김하나,010-1111-2222")).toEqual([{ 성명: "김하나", 연락처: "010-1111-2222" }]);
    expect(detectRosterFormat("성명,연락처")).toBe("csv");
  });
});

describe("정직한 거부 — 조용히 빈칸으로 넘기지 않는다", () => {
  it("빈 입력", () => expect(() => parseRoster("  \n ")).toThrow("명단이 비어 있습니다"));
  it("깨진 JSON은 삼키지 않고 던진다", () => expect(() => parseRoster('[{"성명":"김하나",}]')).toThrow());
  it("CSV 안의 따옴표는 거부하고 대안을 말한다", () => {
    expect(() => parseRoster('성명,비고\n김하나,"가,나"')).toThrow(/따옴표/);
  });
  it("열 수 불일치는 몇 행인지 말한다", () => {
    expect(() => parseRoster("성명,연락처\n김하나")).toThrow("2행: 열 수 1 ≠ 헤더 2");
  });
  it("\"키: 값\" 블록 중간의 깨진 줄", () => {
    expect(() => parseRoster("성명: 김하나\n연락처")).toThrow(/"키: 값" 형식이 아닌 줄/);
  });
});

describe("readRoster — 라이브 미리보기용 안전 래퍼", () => {
  it("성공하면 행·열·형식을 함께 준다", () => {
    const v = readRoster("성명: 김하나\n연락처: 010\n\n성명: 이두리\n주소: 서울");
    expect(v.error).toBeNull();
    expect(v.rows).toHaveLength(2);
    expect(v.columns).toEqual(["성명", "연락처", "주소"]); // 행마다 키가 달라도 합집합
    expect(v.format).toBe("block");
    expect(v.empty).toBe(false);
  });

  it("공백만 있으면 오류가 아니라 empty", () => {
    const v = readRoster("   \n");
    expect(v).toMatchObject({ empty: true, error: null, rows: [], columns: [] });
  });

  it("파싱 실패는 error 문자열로 돌려준다(행 0개로 뭉개지 않는다)", () => {
    const v = readRoster("성명,연락처\n김하나");
    expect(v.rows).toEqual([]);
    expect(v.empty).toBe(false);
    expect(v.error).toBe("2행: 열 수 1 ≠ 헤더 2");
  });
});
