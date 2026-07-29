import { describe, expect, it } from "vitest";
import {
  applyDemoSpec,
  buildDemoRoster,
  DEMO_FIELDS,
  DEMO_PEOPLE,
  diagnoseKeys,
  rosterColumns,
  unmatchedMessage,
  unmatchedReasons,
} from "./bulkFill";

describe("명단 열 ↔ 필드 키 진단", () => {
  it("행마다 키가 달라도 합집합을 순서대로 모은다", () => {
    expect(rosterColumns([{ 성명: "김하나", 연락처: "010" }, { 성명: "이두리", 주소: "서울" }])).toEqual(["성명", "연락처", "주소"]);
  });

  it("헤더 오타 한 글자를 양방향으로 잡는다 (조용한 빈칸 금지)", () => {
    const d = diagnoseKeys(["성명", "연락쳐"], ["성명", "연락처"]);
    expect(d.matched).toEqual(["성명"]);
    expect(d.unmatchedColumns).toEqual(["연락쳐"]);
    expect(d.unmatchedFields).toEqual(["연락처"]);
    expect(unmatchedReasons(d)).toEqual(["unmatched_column:연락쳐", "unmatched_field:연락처"]);
    expect(unmatchedMessage(d)).toContain("연락쳐");
    expect(unmatchedMessage(d)).toContain("연락처");
  });

  it("공백만 다른 이름도 매칭이 아니다 — 채움이 완전 일치라 진단도 같은 규칙", () => {
    const d = diagnoseKeys(["성 명"], ["성명"]);
    expect(d.matched).toEqual([]);
    expect(d.unmatchedColumns).toEqual(["성 명"]);
  });

  it("전부 매칭되면 사유코드도 배너도 없다", () => {
    const d = diagnoseKeys(["성명", "연락처"], ["연락처", "성명"]);
    expect(d.matched).toEqual(["연락처", "성명"]);
    expect(unmatchedReasons(d)).toEqual([]);
    expect(unmatchedMessage(d)).toBeNull();
  });
});

describe("샘플로 체험 — 데모 규격/명단", () => {
  const drafted = [
    { key: "기업명", use: true, specType: "text", required: false },
    { key: "연락처", use: true, specType: "text", required: false },
    { key: "기간", use: true, specType: "text", required: false },
  ];

  it("데모 키만 켜고 형식·필수를 규정, 나머지는 끈다", () => {
    const out = applyDemoSpec(drafted);
    expect(out.find((f) => f.key === "기업명")).toMatchObject({ use: true, specType: "text", required: true });
    expect(out.find((f) => f.key === "연락처")).toMatchObject({ use: true, specType: "phone" });
    expect(out.find((f) => f.key === "기간")).toMatchObject({ use: false });
  });

  it("데모 키가 하나도 없으면(문서 교체) 유도분을 그대로 둔다", () => {
    const other = [{ key: "직위", use: true, specType: "text", required: false }];
    expect(applyDemoSpec(other)).toEqual(other);
  });

  it("데모 명단은 활성 키로만 만들어져 자기 진단에 걸리지 않는다", () => {
    const keys = applyDemoSpec(drafted).filter((f) => f.use).map((f) => f.key);
    const roster = buildDemoRoster(keys);
    const blocks = roster.split("\n\n");
    expect(blocks).toHaveLength(DEMO_PEOPLE.length);
    // "키: 값" 블록 파싱과 같은 규칙으로 열을 뽑아 대조 — 미매칭 0이어야 한다.
    const columns = rosterColumns(blocks.map((b) => Object.fromEntries(b.split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]))));
    expect(unmatchedReasons(diagnoseKeys(columns, keys))).toEqual([]);
    expect(roster).toContain("기업명: ㈜다온소프트");
  });

  it("데모 값이 없는 키도 자리표시자로 채워 매칭이 어긋나지 않는다", () => {
    const roster = buildDemoRoster(["성명"], [{ 기업명: "㈜다온소프트" }]);
    expect(roster).toBe("성명: 성명 예시1");
  });

  it("데모 값은 규정한 형식 검증을 통과한다 (첫 실행 검토 0건)", () => {
    const re: Record<string, RegExp> = {
      phone: /^0\d{1,2}-?\d{3,4}-?\d{4}$/,
      bizno: /^\d{3}-?\d{2}-?\d{5}$/,
    };
    for (const person of DEMO_PEOPLE) {
      for (const f of DEMO_FIELDS) {
        const value = person[f.key];
        expect(value, `${f.key} 데모 값 누락`).toBeTruthy();
        if (re[f.specType]) expect(value).toMatch(re[f.specType]);
      }
    }
  });
});
