// issue 055 — 한도 UX 매핑 단위 테스트: 업로드 전 크기 검사 + DocLimit 문구 매핑.
// 매핑의 부분 문자열은 crates/hwp-ingest/src/limits.rs 의 Display 포맷(정본)과 hwp-mcp open_bytes 의
// 실제 오류 문자열을 그대로 옮긴 것 — 여기 픽스처가 그 포맷의 회귀 가드 역할을 겸한다.
import { describe, expect, it } from "vitest";
import { MAX_RAW_FILE_BYTES, formatBytes, limitMessage, oversizeMessage } from "./limits";

describe("issue 055 — 업로드 전 크기 검사 (MAX_RAW_FILE 64MiB 준거)", () => {
  it("한도 이하는 통과(null), 한도 초과는 정직한 사유", () => {
    expect(MAX_RAW_FILE_BYTES).toBe(64 * 1024 * 1024); // hwp-ingest limits.rs MAX_RAW_FILE 미러
    expect(oversizeMessage(MAX_RAW_FILE_BYTES, "ok.hwp")).toBeNull(); // 딱 한도 = 허용(엔진과 동일: > 만 거부)
    const m = oversizeMessage(MAX_RAW_FILE_BYTES + 1, "big.hwp");
    expect(m).toContain("big.hwp");
    expect(m).toContain("최대 64.0MB");
  });

  it("formatBytes 라벨", () => {
    expect(formatBytes(64 * 1024 * 1024)).toBe("64.0MB");
    expect(formatBytes(1536)).toBe("1.5KB");
    expect(formatBytes(12)).toBe("12B");
  });
});

describe("issue 055 — DocLimit/형식 오류의 사용자 문구 매핑", () => {
  // 왼쪽 픽스처 = 엔진이 실제로 내보내는 message (hwp-ingest limits.rs Display / hwp-mcp open_bytes).
  const cases: Array<[string, string]> = [
    ["raw file too large: 70000000 bytes > 67108864 limit", "파일이 너무 큽니다"],
    ["decompressed size exceeds 268435456-byte limit", "압축 해제 크기"],
    ["too many zip entries: 9999 > 4096 limit", "항목 수"],
    ["table nesting too deep: 100 > 8 limit", "중첩"],
    ["too many paragraphs: 999999 > 200000 limit", "문단 수"],
    ["parser panicked (caught at rhwp boundary)", "파서가 중단"],
    ["unrecognized format (not HWP/HWPX/DOCX/PDF)", "알 수 없는 파일 형식"],
    ["malformed document: bad zip central directory", "문서 구조가 손상"],
  ];
  it.each(cases)("%s → 사용자 문구", (engineMsg, expectFragment) => {
    const out = limitMessage(engineMsg);
    expect(out).not.toBeNull();
    expect(out).toContain(expectFragment);
  });

  it("모르는 오류는 null (호출부가 일반 문구로 폴백 — 아는 척 금지)", () => {
    expect(limitMessage("some totally unrelated engine failure")).toBeNull();
    expect(limitMessage("")).toBeNull();
  });
});
