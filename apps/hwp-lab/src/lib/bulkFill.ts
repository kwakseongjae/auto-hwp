// 벌크 채움(/bulk)의 순수 로직 — UI 상태·엔진에 의존하지 않아 vitest로 잠근다.
//  ① 명단 열 ↔ 필드 키 양방향 매칭 진단: 헤더 오타 하나가 "조용한 빈칸"으로 끝나던 구멍을 막는다
//     (사유코드는 docs/BULK-GUIDE.md의 report.json 표와 한 벌).
//  ② "샘플로 체험" 데모 규격/명단 — 파일 없는 방문자가 업로드 없이 전 플로우를 돌려보는 진입로.

/** 명단 행들에 등장한 열 이름의 합집합. "키: 값" 블록 형식은 행마다 키가 다를 수 있다. */
export function rosterColumns(rows: Record<string, string>[]): string[] {
  const out: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (k && !out.includes(k)) out.push(k);
  return out;
}

export interface KeyDiagnosis {
  matched: string[];
  /** 명단에만 있는 열 — 어느 영역에도 들어가지 않는다(헤더 오타의 주 증상). */
  unmatchedColumns: string[];
  /** 영역에만 있는 키 — 명단에 그 열이 없어 전 행이 빈칸이 된다. */
  unmatchedFields: string[];
}

/** 명단 열 ↔ 활성 필드 키 양방향 대조(양쪽 다 조용히 넘어가지 않게). 매칭은 완전 일치 — 채움
 *  자체가 `row[f.key]` 완전 일치라 진단도 같은 규칙이어야 한다. */
export function diagnoseKeys(columns: string[], fieldKeys: string[]): KeyDiagnosis {
  const cols = new Set(columns);
  const keys = new Set(fieldKeys);
  return {
    matched: fieldKeys.filter((k) => cols.has(k)),
    unmatchedColumns: columns.filter((c) => !keys.has(c)),
    unmatchedFields: fieldKeys.filter((k) => !cols.has(k)),
  };
}

/** report.json 사유코드(배치 레벨 warnings) — BULK-GUIDE 사유코드 표에 그대로 실린다. */
export function unmatchedReasons(d: KeyDiagnosis): string[] {
  return [...d.unmatchedColumns.map((c) => `unmatched_column:${c}`), ...d.unmatchedFields.map((k) => `unmatched_field:${k}`)];
}

/** 배너 문구 — 생성은 진행하되(정직 3단 정책) 무엇이 안 들어갔는지 반드시 말한다. */
export function unmatchedMessage(d: KeyDiagnosis): string | null {
  const parts: string[] = [];
  if (d.unmatchedColumns.length) parts.push(`명단의 열 ${d.unmatchedColumns.map((c) => `"${c}"`).join(", ")}이(가) 어느 영역과도 이름이 같지 않아 문서에 들어가지 않습니다`);
  if (d.unmatchedFields.length) parts.push(`영역 ${d.unmatchedFields.map((k) => `"${k}"`).join(", ")}은(는) 명단에 같은 이름의 열이 없어 전부 빈칸으로 남습니다`);
  if (!parts.length) return null;
  return `${parts.join(" · ")} — 이름은 한 글자도 다르지 않아야 합니다(2단계 필드 이름 또는 명단 헤더를 고쳐주세요).`;
}

// ── "샘플로 체험" 데모 ─────────────────────────────────────────────────────────────────────────
// 템플릿은 랜딩과 같은 public/samples 자산(copy-samples.mjs가 배치하는 레포 벤치마크 문서)을 쓴다.
// 전용 양식 자산이 생기면 파일명만 바꾸면 된다 — 필드는 하드코딩 pin이 아니라 결정론 인스펙션이
// 유도한 것 중 아래 키만 켜는 방식이라 문서가 바뀌어도 조용히 어긋나지 않는다.
// 쪽수는 라벨에 박지 않는다 — 조판 축이 움직이면 화면(doc.pageCount())과 어긋나는 거짓말이 된다.
export const DEMO_TEMPLATE = { file: "sample-18p.hwpx", label: "지원사업 신청서(HWPX)" };

export interface DemoField {
  key: string;
  specType: string;
  required?: boolean;
}

/** 데모 규격 — 인스펙션이 유도한 필드 중 이 키들만 켜고 형식·필수를 규정한다. */
export const DEMO_FIELDS: DemoField[] = [
  { key: "기업명", specType: "text", required: true },
  { key: "사업자등록번호", specType: "bizno" },
  { key: "대표자", specType: "text" },
  { key: "연락처", specType: "phone" },
];

/** 데모 명단 3행(형식 검증을 통과하는 값 — 첫 실행에서 검토 0건이 나오는 게 목적). */
export const DEMO_PEOPLE: Record<string, string>[] = [
  { 기업명: "㈜다온소프트", 사업자등록번호: "220-81-62517", 대표자: "김하나", 연락처: "010-2345-6789" },
  { 기업명: "초록마루협동조합", 사업자등록번호: "135-82-04713", 대표자: "이두리", 연락처: "010-3456-7890" },
  { 기업명: "㈜바다연구소", 사업자등록번호: "621-81-33902", 대표자: "박세온", 연락처: "010-4567-8901" },
];

interface SpecifiableField {
  key: string;
  use: boolean;
  specType: string;
  required: boolean;
}

/** 유도된 필드에 데모 규격을 씌운다. 데모 키가 하나도 없으면(문서 교체 등) 원본을 그대로 둔다 —
 *  전 필드를 꺼서 "필드 0개"로 죽는 것보다 유도분 그대로 돌리는 편이 정직하다. */
export function applyDemoSpec<T extends SpecifiableField>(fields: T[], demo: DemoField[] = DEMO_FIELDS): T[] {
  const byKey = new Map(demo.map((d) => [d.key, d]));
  if (!fields.some((f) => byKey.has(f.key))) return fields;
  return fields.map((f) => {
    const d = byKey.get(f.key);
    return d ? { ...f, use: true, specType: d.specType, required: !!d.required } : { ...f, use: false };
  });
}

/** 활성 필드 키로 데모 명단("키: 값" 블록 — 파서 4형식 중 권장형)을 만든다. 데모 값이 없는 키는
 *  키 이름을 그대로 쓴 자리표시자로 채워 매칭이 어긋나지 않게 한다. */
export function buildDemoRoster(keys: string[], people: Record<string, string>[] = DEMO_PEOPLE): string {
  if (!keys.length) return "";
  return people.map((p, i) => keys.map((k) => `${k}: ${p[k] ?? `${k} 예시${i + 1}`}`).join("\n")).join("\n\n");
}
