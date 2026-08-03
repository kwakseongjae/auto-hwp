// 새로고침 자동 재개 — 마커 라이프사이클 + 재개 판정(순수 로직) 단위 테스트.
// 화면(즉시 열기·토스트·배너 강등)은 e2e(session-resume.spec.ts)가 실브라우저로 검증한다.
import { describe, expect, it, vi } from "vitest";
import { AutosaveController, MemorySnapshotStore, SNAPSHOT_TTL_MS, type SnapshotRecord } from "./autosave";
import {
  LIVE_DOC_MARKER_KEY,
  clearLiveDoc,
  decideResume,
  defaultMarkerStorage,
  readLiveDoc,
  resumeToastMessage,
  writeLiveDoc,
  type MarkerStorage,
} from "./resumeSession";

/** sessionStorage 시임(vitest 는 node 환경 — 실제 sessionStorage 가 없다). */
function fakeStorage(): MarkerStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const rec = (key: string, docName: string, savedAt: number, bytes = new Uint8Array([1])): SnapshotRecord => ({
  key,
  docName,
  openedAt: savedAt - 5_000,
  savedAt,
  rev: 3,
  bytes,
});

describe("마커 라이프사이클", () => {
  it("열기=세팅 · 읽기 · 닫기=제거 (키는 스냅샷 키 그대로)", () => {
    const s = fakeStorage();
    expect(readLiveDoc(s)).toBeNull();
    writeLiveDoc("doc.hwp::100", s);
    expect(s.map.get(LIVE_DOC_MARKER_KEY)).toBe("doc.hwp::100");
    expect(readLiveDoc(s)).toBe("doc.hwp::100");
    clearLiveDoc(s);
    expect(readLiveDoc(s)).toBeNull();
    expect(s.map.size).toBe(0);
  });

  it("문서 교체는 마커를 덮어쓴다(옛 세션 키가 남지 않는다)", () => {
    const s = fakeStorage();
    writeLiveDoc("a.hwp::100", s);
    writeLiveDoc("b.hwp::200", s);
    expect(readLiveDoc(s)).toBe("b.hwp::200");
    expect(s.map.size).toBe(1);
  });

  it("스토리지 없음/접근 거부(시크릿)는 조용히 무시된다 — 앱이 막히지 않는다", () => {
    expect(() => writeLiveDoc("x::1", null)).not.toThrow();
    expect(readLiveDoc(null)).toBeNull();
    expect(() => clearLiveDoc(null)).not.toThrow();

    const hostile: MarkerStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => writeLiveDoc("x::1", hostile)).not.toThrow();
    expect(readLiveDoc(hostile)).toBeNull();
    expect(() => clearLiveDoc(hostile)).not.toThrow();
  });

  it("node 환경(sessionStorage 없음)에서 기본 스토리지는 null 이다 — SSR 안전", () => {
    expect(defaultMarkerStorage()).toBeNull();
  });

  it("AutosaveController.sessionKey() 가 마커 값의 단일 출처다 (열기→키, 닫기→null, 저장 계약 불변)", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemorySnapshotStore();
      const source = { toHwpx: vi.fn(async () => new Uint8Array([7, 7])) };
      const c = new AutosaveController(store, source, { now: () => 1_000 });
      const s = fakeStorage();

      expect(c.sessionKey()).toBeNull();
      c.openSession("보고서.hwp");
      const key = c.sessionKey();
      expect(key).toBe("보고서.hwp::1000");
      writeLiveDoc(key!, s);

      // 자동저장이 실제로 그 키로 스냅샷을 남긴다 → 마커가 가리키는 레코드가 존재한다.
      c.noteEdit();
      await vi.advanceTimersByTimeAsync(2_000);
      const all = await store.list();
      expect(all.map((r) => r.key)).toEqual([key]);
      expect(decideResume(readLiveDoc(s), all, 1_000)).toEqual({ action: "resume", record: all[0] });

      c.closeSession();
      expect(c.sessionKey()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("재개 판정(순수)", () => {
  const now = 1_000_000;
  const mine = rec("a.hwp::900000", "a.hwp", now - 30_000);
  const other = rec("b.hwp::800000", "b.hwp", now - 10_000);

  it("마커 없음 → 랜딩(no-marker): 고아 스냅샷이 있어도 자동 재개하지 않는다(현행 배너 경로)", () => {
    expect(decideResume(null, [mine, other], now)).toEqual({ action: "landing", reason: "no-marker" });
    expect(decideResume("", [mine], now)).toEqual({ action: "landing", reason: "no-marker" });
  });

  it("마커가 가리키는 그 키만 재개한다(더 최신 다른 문서가 있어도 그쪽을 열지 않는다)", () => {
    const d = decideResume(mine.key, [other, mine], now);
    expect(d).toEqual({ action: "resume", record: mine });
  });

  it("마커는 있는데 스냅샷이 없음 → 랜딩(snapshot-missing): 편집 전 새로고침·명시 내보내기 정리 후", () => {
    expect(decideResume("gone.hwp::1", [mine], now)).toEqual({ action: "landing", reason: "snapshot-missing" });
    expect(decideResume("gone.hwp::1", [], now)).toEqual({ action: "landing", reason: "snapshot-missing" });
  });

  it("TTL 만료 스냅샷은 재개하지 않는다(경계: 정확히 TTL 은 생존)", () => {
    const old = rec("a.hwp::1", "a.hwp", now - SNAPSHOT_TTL_MS - 1);
    expect(decideResume(old.key, [old], now)).toEqual({ action: "landing", reason: "snapshot-expired" });
    const edge = rec("a.hwp::2", "a.hwp", now - SNAPSHOT_TTL_MS);
    expect(decideResume(edge.key, [edge], now)).toEqual({ action: "resume", record: edge });
  });

  it("빈 바이트 스냅샷은 재개하지 않는다(손상 방어)", () => {
    const empty = rec("a.hwp::3", "a.hwp", now, new Uint8Array(0));
    expect(decideResume(empty.key, [empty], now)).toEqual({ action: "landing", reason: "snapshot-empty" });
  });

  it("판정은 순수하다 — 입력 레코드를 변형하지 않는다(만료분 청소는 findRecoverable 의 몫)", () => {
    const old = rec("a.hwp::1", "a.hwp", now - SNAPSHOT_TTL_MS - 1);
    const records = [old, mine];
    decideResume(old.key, records, now);
    expect(records).toHaveLength(2);
    expect(records[0].savedAt).toBe(now - SNAPSHOT_TTL_MS - 1);
  });
});

describe("재개 토스트 문구", () => {
  it("마지막 자동저장 **시각**을 반드시 담는다(pagehide flush 는 보장이 아니므로)", () => {
    const savedAt = new Date(2026, 6, 30, 14, 32, 0).getTime();
    const m = resumeToastMessage(savedAt, savedAt + 5 * 60_000);
    expect(m).toContain("새로고침 전 상태로 복구했습니다");
    expect(m).toMatch(/\d{1,2}:\d{2}/); // HH:MM (로캘 무관)
    expect(m).toContain("5분 전"); // 기존 formatAge 라벨 재사용
  });

  it("미래 시각(시계 역행)에도 음수 라벨을 만들지 않는다", () => {
    const t = Date.now();
    expect(resumeToastMessage(t + 10_000, t)).toContain("방금");
  });
});
