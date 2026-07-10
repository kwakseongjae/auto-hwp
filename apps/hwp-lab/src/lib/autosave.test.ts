// issue 052 — AutosaveController/스토어 정책 단위 테스트 (IndexedDB mock = MemorySnapshotStore).
// 디바운스 · 저장 · 문서당 1개 · 상한 · TTL · 명시저장 정리 · 게이트(드래그 중 금지) · IDB 실패
// 1회 안내 후 비활성 · V3 무오염(소스의 toHwpx 외 아무것도 호출하지 않음) · 복구 제안/무시를 잠근다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOSAVE_DEBOUNCE_MS,
  AutosaveController,
  FLUSH_RETRY_MS,
  MemorySnapshotStore,
  SNAPSHOT_TTL_MS,
  findRecoverable,
  formatAge,
  pruneKeys,
  recoveredName,
  type SnapshotRecord,
  type SnapshotStore,
} from "./autosave";

/** V3 계약용 소스 스파이: 자동저장은 이 중 toHwpx만 만질 수 있다(편집 rev/undo 무오염). */
function makeSource(bytes = new Uint8Array([1, 2, 3])) {
  return {
    toHwpx: vi.fn(async () => bytes),
    undo: vi.fn(),
    redo: vi.fn(),
    applyIntent: vi.fn(),
  };
}

const rec = (key: string, docName: string, savedAt: number, n = 1): SnapshotRecord => ({
  key,
  docName,
  openedAt: savedAt - 1000,
  savedAt,
  rev: n,
  bytes: new Uint8Array([n]),
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("디바운스 저장", () => {
  it("연타 편집은 마지막 편집 2s 뒤 정확히 1회 저장된다 (toHwpx 1회 · put 1회 · rev 집계)", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    const c = new AutosaveController(store, source);
    c.openSession("doc.hwp");
    c.noteEdit();
    c.noteEdit();
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(source.toHwpx).not.toHaveBeenCalled(); // 아직 유휴 아님
    await vi.advanceTimersByTimeAsync(1);
    expect(source.toHwpx).toHaveBeenCalledTimes(1);
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].docName).toBe("doc.hwp");
    expect(all[0].rev).toBe(3);
    expect(all[0].key).toMatch(/^doc\.hwp::\d+$/); // 키 = 파일명 + 열기 시각
    expect(all[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("유휴 전에 편집이 이어지면 타이머가 리셋된다", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    const c = new AutosaveController(store, source);
    c.openSession("doc.hwp");
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(1500);
    c.noteEdit(); // 리셋
    await vi.advanceTimersByTimeAsync(1500);
    expect(source.toHwpx).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(source.toHwpx).toHaveBeenCalledTimes(1);
  });

  it("같은 세션의 재저장은 같은 키를 덮어쓴다(세션당 1레코드)", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    const c = new AutosaveController(store, source);
    c.openSession("doc.hwp");
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(source.toHwpx).toHaveBeenCalledTimes(2);
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].rev).toBe(2);
  });

  it("편집이 없으면(문서 열기만) 아무것도 저장되지 않는다 — 유령 배너 금지", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    const c = new AutosaveController(store, source);
    c.openSession("doc.hwp");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.toHwpx).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(0);
  });

  it("closeSession은 대기 중 스냅샷을 취소한다(닫힌 문서를 직렬화하지 않는다)", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    const c = new AutosaveController(store, source);
    c.openSession("doc.hwp");
    c.noteEdit();
    c.closeSession();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.toHwpx).not.toHaveBeenCalled();
  });
});

describe("flush 게이트 (toHwpx는 유휴에서만 — 드래그 중 금지)", () => {
  it("게이트가 막으면 retryMs 뒤로 미루고, 풀리면 저장한다", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    let dragging = true;
    const c = new AutosaveController(store, source, { canFlushNow: () => !dragging });
    c.openSession("doc.hwp");
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + FLUSH_RETRY_MS * 3);
    expect(source.toHwpx).not.toHaveBeenCalled(); // 제스처 내내 호출 금지
    dragging = false;
    await vi.advanceTimersByTimeAsync(FLUSH_RETRY_MS);
    expect(source.toHwpx).toHaveBeenCalledTimes(1);
  });
});

describe("V3 무오염 계약 (mock adapter로 잠금)", () => {
  it("자동저장은 소스의 toHwpx만 호출한다 — undo/redo/applyIntent 0회", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    const c = new AutosaveController(store, source);
    c.openSession("doc.hwp");
    for (let i = 0; i < 5; i++) {
      c.noteEdit();
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    }
    expect(source.toHwpx).toHaveBeenCalledTimes(5);
    expect(source.undo).not.toHaveBeenCalled();
    expect(source.redo).not.toHaveBeenCalled();
    expect(source.applyIntent).not.toHaveBeenCalled();
  });
});

describe("문서당 1개 · 전체 상한 · TTL (pruneKeys + 통합)", () => {
  it("pruneKeys: 같은 문서의 옛 세션 키를 지운다 (문서당 최신 1개)", () => {
    const now = 1_000_000;
    const records = [rec("a.hwp::1", "a.hwp", now - 100), rec("a.hwp::2", "a.hwp", now - 50), rec("b.hwp::1", "b.hwp", now - 10)];
    expect(pruneKeys(records, "a.hwp::2", "a.hwp", now)).toEqual(["a.hwp::1"]);
  });

  it("pruneKeys: TTL 7일 만료분을 지운다", () => {
    const now = SNAPSHOT_TTL_MS * 2;
    const records = [rec("old.hwp::1", "old.hwp", now - SNAPSHOT_TTL_MS - 1), rec("new.hwp::1", "new.hwp", now - 1000)];
    expect(pruneKeys(records, "cur.hwp::1", "cur.hwp", now)).toEqual(["old.hwp::1"]);
  });

  it("pruneKeys: 전체 상한 초과분은 오래된 순으로 지운다 (현재 키는 항상 생존)", () => {
    const now = 1_000_000;
    const records = [rec("a::1", "a", now - 400), rec("b::1", "b", now - 300), rec("c::1", "c", now - 200), rec("cur::1", "cur", now - 1)];
    const out = pruneKeys(records, "cur::1", "cur", now, SNAPSHOT_TTL_MS, 2);
    expect(out.sort()).toEqual(["a::1", "b::1"]); // cur + c 생존 (상한 2)
    expect(out).not.toContain("cur::1");
  });

  it("통합: 같은 문서를 두 번 열고 편집하면 옛 세션 스냅샷이 대체된다", async () => {
    const store = new MemorySnapshotStore();
    let t = 1_000_000;
    const now = () => t;
    const c1 = new AutosaveController(store, makeSource(new Uint8Array([1])), { now });
    c1.openSession("doc.hwp");
    c1.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    t += 10_000;
    const c2 = new AutosaveController(store, makeSource(new Uint8Array([2])), { now });
    c2.openSession("doc.hwp");
    c2.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].bytes).toEqual(new Uint8Array([2]));
  });
});

describe("명시 저장/내보내기 정리 (v1 R13)", () => {
  it("markExported: 이 세션의 스냅샷을 지우고 대기 타이머를 끈다 — 이후 새 편집은 다시 저장", async () => {
    const store = new MemorySnapshotStore();
    const source = makeSource();
    const c = new AutosaveController(store, source);
    c.openSession("doc.hwp");
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(await store.list()).toHaveLength(1);
    c.noteEdit(); // 대기 중 편집 — 내보내기 결과물에 이미 포함되므로 타이머도 정리 대상
    await c.markExported();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await store.list()).toHaveLength(0);
    expect(source.toHwpx).toHaveBeenCalledTimes(1); // markExported 이후 추가 호출 없음
    c.noteEdit(); // 내보내기 뒤의 새 편집은 다시 스냅샷된다
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(await store.list()).toHaveLength(1);
  });
});

describe("IndexedDB 실패 — 1회 안내 후 비활성 (조용한 무시 금지)", () => {
  function failingStore(): SnapshotStore {
    return {
      list: async () => [],
      put: async () => {
        throw new Error("QuotaExceededError");
      },
      delete: async () => {},
    };
  }

  it("put 실패 → onDisabled 정확히 1회, 이후 영속화만 비활성(메모리 스냅샷은 유지)", async () => {
    const source = makeSource();
    const onDisabled = vi.fn();
    const c = new AutosaveController(failingStore(), source, { onDisabled });
    c.openSession("doc.hwp");
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(onDisabled).toHaveBeenCalledTimes(1);
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(onDisabled).toHaveBeenCalledTimes(1); // 두 번 알리지 않는다
    // 영속화는 껐지만 메모리 스냅샷은 계속 갱신된다 — 트랩 직후 복구는 여전히 동작.
    expect(c.getRecoverySnapshot()).not.toBeNull();
    expect(c.getRecoverySnapshot()!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("toHwpx 실패는 저장만 건너뛰고(onError) 스토어를 비활성화하지 않는다", async () => {
    const store = new MemorySnapshotStore();
    const onError = vi.fn();
    const onDisabled = vi.fn();
    const source = {
      toHwpx: vi.fn().mockRejectedValueOnce(Object.assign(new Error("trap"), { code: "wasm_trap" })).mockResolvedValue(new Uint8Array([5])),
    };
    const c = new AutosaveController(store, source, { onError, onDisabled });
    c.openSession("doc.hwp");
    c.noteEdit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDisabled).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(0);
    c.noteEdit(); // 다음 편집이 자연 재시도
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(await store.list()).toHaveLength(1);
  });
});

describe("복구 제안 / 무시 / 재귀속", () => {
  it("findRecoverable: 최신 유효 스냅샷을 돌려주고 만료분은 청소한다", async () => {
    const store = new MemorySnapshotStore();
    const now = SNAPSHOT_TTL_MS * 2;
    await store.put(rec("old::1", "old.hwp", now - SNAPSHOT_TTL_MS - 1));
    await store.put(rec("a::1", "a.hwp", now - 5000, 1));
    await store.put(rec("b::1", "b.hwp", now - 1000, 2));
    const found = await findRecoverable(store, now);
    expect(found?.key).toBe("b::1"); // 최신 1건
    expect((await store.list()).map((r) => r.key).sort()).toEqual(["a::1", "b::1"]); // 만료분 청소됨
  });

  it("무시 = 삭제: store.delete 후 findRecoverable은 null", async () => {
    const store = new MemorySnapshotStore();
    await store.put(rec("a::1", "a.hwp", 1000));
    await store.delete("a::1");
    expect(await findRecoverable(store, 2000)).toBeNull();
  });

  it("adoptRecovered: 복구본을 새 세션 키로 재귀속하고 옛 키를 지운다 (콘텐츠 무손실)", async () => {
    const store = new MemorySnapshotStore();
    const old = rec("doc.hwp::1", "doc.hwp", 1000, 7);
    await store.put(old);
    const c = new AutosaveController(store, makeSource(), { now: () => 5000 });
    c.openSession("doc (복구본).hwpx");
    await c.adoptRecovered(old);
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].key).toBe("doc (복구본).hwpx::5000");
    expect(all[0].bytes).toEqual(old.bytes);
    // 재귀속 직후부터 트랩 복구 소스가 살아 있다 (편집 전에도).
    expect(c.getRecoverySnapshot()?.bytes).toEqual(old.bytes);
  });
});

describe("표시 헬퍼", () => {
  it("formatAge: 방금/분/시간/일", () => {
    expect(formatAge(30_000)).toBe("방금");
    expect(formatAge(5 * 60_000)).toBe("5분 전");
    expect(formatAge(3 * 3_600_000)).toBe("3시간 전");
    expect(formatAge(50 * 3_600_000)).toBe("2일 전");
  });

  it("recoveredName: 편집된 HWPX임을 파일명부터 명시", () => {
    expect(recoveredName("보고서.hwp")).toBe("보고서 (복구본).hwpx");
    expect(recoveredName("양식.hwpx")).toBe("양식 (복구본).hwpx");
  });
});
