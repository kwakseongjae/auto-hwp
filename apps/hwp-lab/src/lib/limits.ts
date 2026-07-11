// issue 055 — 한도 UX: 업로드 전 크기 검사 + DocLimit 계열 엔진 오류의 사용자 문구 매핑.
//
// 엔진(crates/hwp-ingest/src/limits.rs)은 신뢰불가 입력을 typed DocLimit 로 거부한다(R4). 웹 셸의
// 몫은 ① 64MiB 초과 파일을 "파싱을 시작하기 전에" 정직하게 거부하고(대형 파일을 워커에 복사해
// 실패를 기다리는 낭비 금지), ② 파싱 중 표면화된 한도/형식 오류를 사람이 읽을 한국어로 바꾸는 것.
//
// 이 파일은 헤드리스(React 无)다 — LabWorkspace 가 배너/토스트를 붙인다. 문구 매핑은 엔진 오류
// message 의 "구별 가능한 부분 문자열"에만 의존한다(hwp-ingest limits.rs 의 Display 포맷 — 그 파일이
// 정본이고, 여기 매핑이 어긋나면 limits.test.ts 가 잡는다).

/** hwp-ingest limits.rs `MAX_RAW_FILE` 의 웹 미러 — 64 MiB. 업로드 전(파싱 전) 크기 검사 기준.
 *  ⚠️ 정본은 Rust 상수다: 값을 바꾸려면 crates/hwp-ingest/src/limits.rs 와 함께 바꿔라. */
export const MAX_RAW_FILE_BYTES = 64 * 1024 * 1024;

/** 사람이 읽는 크기 라벨 (예: 67.2MB). */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/** 업로드 전 크기 검사: 한도 초과면 거부 사유 문자열, 통과면 null. 파싱/워커 복사 이전에 부른다. */
export function oversizeMessage(size: number, name: string): string | null {
  if (size <= MAX_RAW_FILE_BYTES) return null;
  return (
    `파일이 너무 큽니다: ${name} (${formatBytes(size)})\n` +
    `최대 ${formatBytes(MAX_RAW_FILE_BYTES)}까지 열 수 있습니다. 문서를 나누거나 불필요한 이미지를 줄여 다시 시도하세요.`
  );
}

/** 엔진 open 오류 message → 사용자 문구. DocLimit/형식 계열만 매핑하고, 모르는 오류는 null
 *  (호출부가 기존 일반 문구로 폴백 — 아는 척 금지). 부분 문자열은 hwp-ingest limits.rs Display +
 *  hwp-mcp open_bytes 의 실제 포맷. */
export function limitMessage(message: string): string | null {
  if (message.includes("raw file too large")) {
    return `파일이 너무 큽니다. 최대 ${formatBytes(MAX_RAW_FILE_BYTES)}까지 열 수 있습니다.`;
  }
  if (message.includes("decompressed size exceeds")) {
    return "문서의 압축 해제 크기가 허용 한도(256MiB)를 초과합니다. 손상되었거나 비정상적으로 압축된 파일일 수 있습니다.";
  }
  if (message.includes("too many zip entries")) {
    return "문서 내부 항목 수가 허용 한도를 초과합니다. 비정상적인 파일일 수 있습니다.";
  }
  if (message.includes("table nesting too deep")) {
    return "표 안에 표가 너무 깊게 중첩되어 있습니다(최대 8단계). 문서를 단순화한 뒤 다시 시도하세요.";
  }
  if (message.includes("too many paragraphs")) {
    return "문단 수가 허용 한도(200,000개)를 초과합니다. 문서를 나눠서 열어 주세요.";
  }
  if (message.includes("parser panicked")) {
    return "문서를 해석하는 중 파서가 중단되었습니다. 손상되었거나 지원하지 않는 구조의 파일일 수 있습니다.";
  }
  if (message.includes("unrecognized format")) {
    return "알 수 없는 파일 형식입니다. .hwp / .hwpx 문서인지 확인해 주세요.";
  }
  if (message.includes("malformed document")) {
    return "문서 구조가 손상되어 열 수 없습니다. 원본 프로그램에서 다시 저장한 뒤 시도해 보세요.";
  }
  return null;
}
