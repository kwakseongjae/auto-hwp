// 새로고침 자동 재개 — 052 자동저장 **위에 얹는 재개 규칙 레이어**.
//
// 052 는 "편집본 스냅샷을 남긴다"까지만 책임진다(스냅샷 포맷·TTL 7일·문서당 1개·전체 상한 계약은
// autosave.ts 가 소유하며 이 파일은 그 계약을 한 글자도 바꾸지 않는다). 여기서 더하는 것은 하나다:
// **"방금 보던 문서를 새로고침한 것인가?"를 판별해, 맞으면 배너 없이 그 자리로 돌려보낸다.**
//
// 판별 장치는 sessionStorage 마커 하나뿐이다:
//  - sessionStorage = 탭 수명 = "새로고침"의 정확한 정의다. 새 탭·내일 방문에는 자연히 없으므로
//    "예전에 편집하던 문서가 허락 없이 되살아나는" 일이 구조적으로 불가능하다.
//  - 마커 값 = 열려 있는 문서의 **스냅샷 키**(AutosaveController.sessionKey()). 어느 스냅샷으로
//    돌아갈지가 명시적이라, 다른 문서의 고아 스냅샷을 잘못 되살리지 않는다.
//  - 마커 없음(고아 스냅샷) = **현행 복구 배너 경로 그대로**(opt-in) — 052 동작 무변경.
//
// 이 파일은 헤드리스(React/DOM 의존 无 — 스토리지는 주입 가능)다: 판정은 순수 함수, 저장소 접근은
// 얇은 시임. LabWorkspace 가 화면(즉시 열기·토스트·배너 강등)을 붙인다.
import { SNAPSHOT_TTL_MS, formatAge, type SnapshotRecord } from "./autosave";

/** 탭 단위 "지금 열려 있는 문서" 마커. 값은 스냅샷 키(`${docName}::${openedAt}`). */
export const LIVE_DOC_MARKER_KEY = "auto-hwp:live-doc";

/** sessionStorage 시임(테스트 주입용 — vitest 는 node 환경이라 실제 sessionStorage 가 없다). */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 브라우저 기본 저장소. 시크릿/차단 브라우저는 **접근 자체가 throw** 하므로 통째로 감싼다.
 *  없으면 null → 마커 기능만 조용히 꺼지고(자동 재개 없음) 기존 배너 경로는 그대로 동작한다. */
export function defaultMarkerStorage(): MarkerStorage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

/** 문서 열기 성공 시 호출 — 이 탭이 보고 있는 스냅샷 키를 기록한다. */
export function writeLiveDoc(key: string, storage: MarkerStorage | null = defaultMarkerStorage()): void {
  try {
    storage?.setItem(LIVE_DOC_MARKER_KEY, key);
  } catch {
    /* 용량/권한 거부 — 자동 재개만 못 할 뿐, 자동저장·배너는 계속 동작한다. */
  }
}

export function readLiveDoc(storage: MarkerStorage | null = defaultMarkerStorage()): string | null {
  try {
    return storage?.getItem(LIVE_DOC_MARKER_KEY) ?? null;
  } catch {
    return null;
  }
}

/** 명시적 닫기·재개 실패·스냅샷 소멸 시 호출 — 마커만 지운다(**스냅샷은 절대 지우지 않는다**:
 *  사용자 콘텐츠 삭제 금지. 마커가 사라진 스냅샷은 고아가 되어 현행 배너로 다시 제안된다). */
export function clearLiveDoc(storage: MarkerStorage | null = defaultMarkerStorage()): void {
  try {
    storage?.removeItem(LIVE_DOC_MARKER_KEY);
  } catch {
    /* 접근 거부 — 무시 */
  }
}

/** 재개 판정 결과. landing 은 "자동 재개하지 않는다"이며, 그 다음은 언제나 현행 배너 경로다. */
export type ResumeDecision =
  | { action: "resume"; record: SnapshotRecord }
  | { action: "landing"; reason: "no-marker" | "snapshot-missing" | "snapshot-expired" | "snapshot-empty" };

/**
 * 재개 판정(순수): 마커 + 스냅샷 목록 → 즉시 열 레코드 or 랜딩 사유.
 *
 * 규칙은 보수적이다 — 마커가 가리키는 **바로 그 키**만 재개 대상이다. 스냅샷이 없거나(편집 전
 * 새로고침·명시 내보내기로 정리됨), 만료됐거나, 바이트가 비었으면 랜딩으로 떨어진다(호출자가
 * 마커를 지운다). 랜딩 사유를 구분해 돌려주는 이유는 "조용히 랜딩"과 "정직한 안내"를 화면 쪽에서
 * 나눠 처리할 수 있게 하기 위함이다.
 */
export function decideResume(
  marker: string | null,
  records: SnapshotRecord[],
  now: number = Date.now(),
  ttlMs: number = SNAPSHOT_TTL_MS,
): ResumeDecision {
  if (!marker) return { action: "landing", reason: "no-marker" };
  const rec = records.find((r) => r.key === marker);
  if (!rec) return { action: "landing", reason: "snapshot-missing" };
  if (now - rec.savedAt > ttlMs) return { action: "landing", reason: "snapshot-expired" };
  if (rec.bytes.length === 0) return { action: "landing", reason: "snapshot-empty" };
  return { action: "resume", record: rec };
}

/** 재개 토스트 문구. **시각을 반드시 표기한다** — pagehide flush 는 보장이 아니므로(아래 참조)
 *  "언제까지의 편집이 살아 있는지"를 사용자가 눈으로 확인할 수 있어야 정직하다. */
export function resumeToastMessage(savedAt: number, now: number = Date.now()): string {
  const at = new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `새로고침 전 상태로 복구했습니다 — 마지막 자동저장 ${at} (${formatAge(Math.max(0, now - savedAt))})`;
}
