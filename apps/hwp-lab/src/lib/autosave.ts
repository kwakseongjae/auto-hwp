// issue 052 — 자동저장 + 세션 복구 영속성 (wasm 트랩 안전망).
//
// 스냅샷 = adapter.toHwpx() 바이트("편집된 HWPX본" — 원본 .hwp가 아니다). 실측(이슈 052 1단계):
// benchmark2 25p 기준 toHwpx 16.6~16.8ms(예산 50ms 대비 2.8× 헤드룸), V3 무오염(재조판/리비전/undo
// 스택 불변, 바이트 결정적) 검증 통과 → 트리거는 "성공한 콘텐츠 편집 후 2s 유휴 디바운스"로 확정.
//
// 함정 준수:
//  - toHwpx는 동기 메인스레드(FG-14 워커화 전) — 유휴 디바운스로만 호출하고, 포인터 제스처(드래그)
//    진행 중이면 `canFlushNow` 게이트가 flush를 뒤로 미룬다(렌더-0 규율 파손 금지).
//  - IndexedDB는 시크릿 모드/용량 초과로 거부될 수 있다 — 첫 실패에서 `onDisabled`로 1회 안내하고
//    저장 기능을 비활성화한다(조용한 무시 금지). 단 메모리 내 최신 스냅샷(`getRecoverySnapshot`)은
//    유지되므로 트랩 직후 복구는 IndexedDB 없이도 동작한다.
//  - 편집 rev/undo 무오염: 이 모듈은 소스의 `toHwpx()` 하나만 호출한다(계약은 vitest가 잠근다).
//
// 이 파일은 헤드리스(React/DOM 无)다 — LabWorkspace가 DOM 게이트/배너/토스트를 붙인다.

export interface SnapshotRecord {
  /** 저장 키 = `${docName}::${openedAt}` — 파일명 + 열기 시각(세션당 1키, 덮어쓰기 저장). */
  key: string;
  /** 열 때의 파일명(표시용 — 복구본은 "편집된 HWPX"임을 배너가 명시한다). */
  docName: string;
  /** 세션 열기 시각 (ms epoch). */
  openedAt: number;
  /** 마지막 스냅샷 시각 (ms epoch) — TTL/배너 "N분 전"의 기준. */
  savedAt: number;
  /** 스냅샷 시점까지의 누적 편집 수(디버그/라벨용). */
  rev: number;
  /** toHwpx() 직렬화 바이트 — 재열기 가능한 HWPX. */
  bytes: Uint8Array;
}

/** 영속 계층 시임 — 실구현은 IndexedDB(IdbSnapshotStore), 테스트/폴백은 MemorySnapshotStore. */
export interface SnapshotStore {
  list(): Promise<SnapshotRecord[]>;
  put(rec: SnapshotRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 편집 후 유휴 디바운스(설계 확정값 — 실측 헤드룸 2.8×로 빈도 조정 불필요). */
export const AUTOSAVE_DEBOUNCE_MS = 2000;
/** 스냅샷 TTL 7일 (v1 R13). */
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 전체 저장 상한(문서 수 기준; 문서당 1개 규칙 위에 얹힌 안전 상한). */
export const MAX_SNAPSHOT_COUNT = 5;
/** flush 게이트(드래그 중) 차단 시 재시도 간격. */
export const FLUSH_RETRY_MS = 500;

// ── in-memory store (vitest "IndexedDB mock" + non-browser fallback) ─────────────────────────────────
export class MemorySnapshotStore implements SnapshotStore {
  private map = new Map<string, SnapshotRecord>();
  async list(): Promise<SnapshotRecord[]> {
    return [...this.map.values()];
  }
  async put(rec: SnapshotRecord): Promise<void> {
    this.map.set(rec.key, { ...rec });
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

// ── IndexedDB store ──────────────────────────────────────────────────────────────────────────────────
const DB_NAME = "tf-hwp-lab-autosave";
const DB_VERSION = 1;
const STORE = "snapshots";

/** 얇은 IndexedDB 바인딩(키=record.key). 실패는 reject로 표면화된다 — AutosaveController가 1회
 *  안내 후 비활성화를 담당한다. (레코드의 Uint8Array는 structured clone으로 그대로 저장된다.) */
export class IdbSnapshotStore implements SnapshotStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("IndexedDB unavailable"));
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
        req.onblocked = () => reject(new Error("IndexedDB open blocked"));
      });
      // 실패한 open은 캐시하지 않는다(다음 호출이 재시도할 수 있게).
      this.db.catch(() => {
        this.db = null;
      });
    }
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
      t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  async list(): Promise<SnapshotRecord[]> {
    const rows = await this.tx<unknown[]>("readonly", (s) => s.getAll() as IDBRequest<unknown[]>);
    return (rows as SnapshotRecord[]).map((r) => ({ ...r, bytes: toU8(r.bytes) }));
  }
  async put(rec: SnapshotRecord): Promise<void> {
    await this.tx("readwrite", (s) => s.put(rec));
  }
  async delete(key: string): Promise<void> {
    await this.tx("readwrite", (s) => s.delete(key));
  }
}

// structured clone은 Uint8Array를 보존하지만, 방어적으로 ArrayBuffer로 나온 경우도 감싼다.
function toU8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(0);
}

// ── prune 정책 (순수 함수 — vitest 대상) ────────────────────────────────────────────────────────────
/** 삭제할 키 목록: ① 같은 문서의 다른(옛) 세션 키 — "문서당 최신 1개" ② TTL 만료 ③ 전체 상한 초과분
 *  (savedAt 오래된 순). `currentKey`는 항상 생존한다. */
export function pruneKeys(
  records: SnapshotRecord[],
  currentKey: string,
  docName: string,
  now: number,
  ttlMs: number = SNAPSHOT_TTL_MS,
  maxCount: number = MAX_SNAPSHOT_COUNT,
): string[] {
  const doomed = new Set<string>();
  for (const r of records) {
    if (r.key === currentKey) continue;
    if (r.docName === docName) doomed.add(r.key); // 문서당 최신 1개
    else if (now - r.savedAt > ttlMs) doomed.add(r.key); // TTL 7일
  }
  const survivors = records.filter((r) => r.key !== currentKey && !doomed.has(r.key)).sort((a, b) => a.savedAt - b.savedAt);
  const over = survivors.length + 1 - maxCount; // +1 = currentKey 자신
  for (let i = 0; i < over; i++) doomed.add(survivors[i].key);
  return [...doomed];
}

// ── 복구 배너 질의 ───────────────────────────────────────────────────────────────────────────────────
/** 미복구 스냅샷 중 가장 최근 것(만료분은 이 자리에서 청소). 배너 하나(v1)만 띄우므로 최신 1건. */
export async function findRecoverable(store: SnapshotStore, now: number = Date.now(), ttlMs: number = SNAPSHOT_TTL_MS): Promise<SnapshotRecord | null> {
  const all = await store.list();
  let latest: SnapshotRecord | null = null;
  for (const r of all) {
    if (now - r.savedAt > ttlMs || r.bytes.length === 0) {
      await store.delete(r.key).catch(() => {});
      continue;
    }
    if (!latest || r.savedAt > latest.savedAt) latest = r;
  }
  return latest;
}

/** 배너용 "N분 전" 라벨. */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "방금";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 복구본 열기 이름: "x.hwp" → "x (복구본).hwpx" — 편집된 HWPX임을 파일명부터 명시(원본과 혼동 금지). */
export function recoveredName(docName: string): string {
  const base = docName.replace(/\.(hwpx?|HWPX?)$/, "");
  return `${base} (복구본).hwpx`;
}

// ── AutosaveController ──────────────────────────────────────────────────────────────────────────────
export interface AutosaveOptions {
  debounceMs?: number;
  ttlMs?: number;
  maxCount?: number;
  retryMs?: number;
  /** 시계 주입(테스트). */
  now?: () => number;
  /** flush 게이트: false면(예: 포인터 드래그 진행 중) retryMs 뒤로 미룬다 — toHwpx는 유휴에서만. */
  canFlushNow?: () => boolean;
  /** 스냅샷 영속 성공 알림(상태 표시용). */
  onSaved?: (rec: SnapshotRecord) => void;
  /** IndexedDB 실패 1회 안내 — 이후 영속 저장은 비활성(메모리 스냅샷/트랩 복구는 계속 동작). */
  onDisabled?: (reason: string) => void;
  /** toHwpx 실패 등 비영속 오류(엔진 트랩은 어댑터가 이미 복구/토스트) — 저장만 건너뛴다. */
  onError?: (e: unknown) => void;
}

/** 자동저장 오케스트레이터(헤드리스): 편집 신호(noteEdit) → 2s 유휴 디바운스 → toHwpx → store.put →
 *  prune. WasmAdapter.setRecoverySource에는 `getRecoverySnapshot`을 물린다(메모리 최신본 — IDB와 독립). */
export class AutosaveController {
  private session: { key: string; docName: string; openedAt: number } | null = null;
  private rev = 0;
  private savedRev = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private storeDisabled = false;
  private flushing = false;
  private last: { bytes: Uint8Array; savedAt: number; rev: number } | null = null;

  constructor(
    private store: SnapshotStore,
    private source: { toHwpx(): Promise<Uint8Array> },
    private opts: AutosaveOptions = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** 문서 열기 성공 시 호출 — 새 세션 키를 만들고 카운터/타이머를 리셋한다. */
  openSession(docName: string): void {
    this.cancelTimer();
    const openedAt = this.now();
    this.session = { key: `${docName}::${openedAt}`, docName, openedAt };
    this.rev = 0;
    this.savedRev = 0;
    this.last = null;
  }

  /** 문서 닫힘 — 대기 중 스냅샷 취소(닫힌 문서를 뒤늦게 직렬화하지 않는다). */
  closeSession(): void {
    this.cancelTimer();
    this.session = null;
    this.last = null;
  }

  /** 성공한 콘텐츠 편집 1회 — WasmAdapter.onMutation이 부른다. 디바운스를 (재)무장한다. */
  noteEdit(): void {
    if (!this.session) return;
    this.rev++;
    this.armTimer(this.opts.debounceMs ?? AUTOSAVE_DEBOUNCE_MS);
  }

  /** 트랩 복구용 최신 스냅샷(메모리) — IndexedDB가 죽어도 동작한다. */
  getRecoverySnapshot(): { bytes: Uint8Array; label?: string } | null {
    if (!this.last) return null;
    return { bytes: this.last.bytes, label: `rev ${this.last.rev}` };
  }

  /** 명시 저장/내보내기 성공 — 이 세션의 스냅샷을 정리(v1 R13)하고 대기 타이머를 끈다.
   *  이후 새 편집이 오면 다시 저장된다. 메모리 최신본은 유지(트랩 복구는 더 정확할수록 좋다). */
  async markExported(): Promise<void> {
    this.cancelTimer();
    this.savedRev = this.rev;
    const key = this.session?.key;
    if (key && !this.storeDisabled) await this.store.delete(key).catch(() => {});
  }

  /** 복구본으로 문서를 다시 연 직후 호출: 복구된 바이트를 새 세션의 rev 0 스냅샷으로 재귀속하고
   *  (reload 직후 재트랩/재이탈에도 안전) 옛 키를 지운다 — 콘텐츠는 절대 유실되지 않는다. */
  async adoptRecovered(rec: SnapshotRecord): Promise<void> {
    if (!this.session) return;
    this.last = { bytes: rec.bytes, savedAt: this.now(), rev: 0 };
    if (!this.storeDisabled) {
      const mine: SnapshotRecord = { key: this.session.key, docName: this.session.docName, openedAt: this.session.openedAt, savedAt: this.now(), rev: 0, bytes: rec.bytes };
      try {
        await this.store.put(mine);
        if (rec.key !== mine.key) await this.store.delete(rec.key);
      } catch (e) {
        this.disableStore(e);
      }
    }
  }

  dispose(): void {
    this.closeSession();
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private armTimer(ms: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 유휴 flush: 게이트가 막으면(드래그 중) retryMs 뒤로 미루고, 소스의 toHwpx() 하나만 호출한다. */
  async flush(): Promise<void> {
    const session = this.session;
    if (!session || this.flushing) return;
    if (this.rev === this.savedRev) return; // 저장할 새 편집 없음
    if (this.opts.canFlushNow && !this.opts.canFlushNow()) {
      this.armTimer(this.opts.retryMs ?? FLUSH_RETRY_MS); // 제스처 진행 중 — 유휴로 재시도
      return;
    }
    this.flushing = true;
    const revAtStart = this.rev;
    try {
      let bytes: Uint8Array;
      try {
        bytes = await this.source.toHwpx();
      } catch (e) {
        // 엔진 오류(트랩 포함) — 저장만 건너뛴다. revAtStart를 소진 처리해 2s 재시도 폭주를 막고,
        // 다음 편집(noteEdit)이 자연히 재시도한다. (트랩이면 어댑터가 이미 복구/롤백했다.)
        this.savedRev = revAtStart;
        this.opts.onError?.(e);
        return;
      }
      const rec: SnapshotRecord = { key: session.key, docName: session.docName, openedAt: session.openedAt, savedAt: this.now(), rev: revAtStart, bytes };
      this.last = { bytes, savedAt: rec.savedAt, rev: revAtStart };
      this.savedRev = revAtStart;
      if (!this.storeDisabled) {
        try {
          await this.store.put(rec);
          const all = await this.store.list();
          for (const key of pruneKeys(all, session.key, session.docName, this.now(), this.opts.ttlMs ?? SNAPSHOT_TTL_MS, this.opts.maxCount ?? MAX_SNAPSHOT_COUNT)) {
            await this.store.delete(key);
          }
          this.opts.onSaved?.(rec);
        } catch (e) {
          this.disableStore(e);
        }
      }
    } finally {
      this.flushing = false;
      // flush 도중 새 편집이 왔으면(세션 동일) 즉시 재무장 — 마지막 편집도 반드시 스냅샷된다.
      if (this.session === session && this.rev !== this.savedRev) this.armTimer(this.opts.debounceMs ?? AUTOSAVE_DEBOUNCE_MS);
    }
  }

  private disableStore(e: unknown): void {
    if (this.storeDisabled) return;
    this.storeDisabled = true;
    this.opts.onDisabled?.(String(e)); // 1회 안내 후 비활성 — 조용한 무시 금지
  }
}
