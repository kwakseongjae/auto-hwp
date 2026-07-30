// 벌크 채움(/bulk) 생성 파이프라인의 엔진 대화부 — 073 2단계(워커화).
//
// 1단계는 메인스레드 동기 루프에 MessageChannel yield만 끼운 것이라 100명 배치에서 6~10초 동안
// 탭이 사실상 잠겼다(리페인트만 겨우 돌았다). 2단계는 이 파일의 모든 엔진 호출을 **EngineLane**
// 추상 뒤로 밀어넣는다. 실제 레인은 packages/engine의 `worker.js`(모듈 워커) — 파싱·채움·직렬화·
// 조판이 전부 워커 스레드에서 돌고 메인스레드는 RPC 응답만 기다린다.
//
// 설계 규칙(전부 기존 계약 유지):
//  * **행 격리**: 한 행이 죽어도 배치를 접지 않는다(`row_failed` + 완성분 보존). wasm 트랩/워커 사망은
//    `recover()`(레인 reset)로 되살리고 다음 행을 계속한다.
//  * **재개봉 검증 3종**(값 존재 · 쪽수 == 무편집 왕복 기준선 · 형식)은 **생성 시점**에 그대로 한다.
//    lazy로 미룬 것은 **검수 SVG뿐**(메모리) — 검증을 미루면 report.json이 거짓이 된다.
//  * **결정론·LLM 0콜·100% 로컬**: 레인은 엔진 메서드 화이트리스트(worker.js METHODS)만 부른다.
//  * 산출물은 다운로드 전용(undo 없음) — 여기서 되돌릴 상태를 만들지 않는다.
//
// 이 파일은 엔진을 import하지 않는다(순수 로직 — 가짜 레인으로 vitest가 잠근다). 실제 레인 구현은
// `bulkLane.ts`.

/** 벌크가 쓰는 엔진 표면. worker.js의 RPC(EngineWorkerClient)와 메인스레드 HwpDoc 양쪽이 만족한다.
 *  **문서 1개 계약**: `open`은 직전 문서를 닫는다(워커와 동일) — 한 번에 한 문서만 살아 있다. */
export interface EngineLane {
  open(bytes: Uint8Array, name?: string): Promise<{ pages: number }>;
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export interface BulkPin {
  section: number;
  index: number;
  row: number;
  col: number;
}

/** 채울 영역 1개 — 필드 카드(UI)에서 규정한 것이 그대로 넘어온다. */
export interface FillTarget {
  key: string;
  pin: BulkPin;
  required: boolean;
  example: string;
  /** 형식 규정 검사. 위반 시 사유 문자열(`format_mismatch:키(...)`의 괄호 안)을 돌려준다. null=통과. */
  formatError?: (value: string) => string | null;
}

export interface FilledValue {
  key: string;
  value: string;
  addr: string;
  example: string;
}

export interface RowCore {
  /** 명단에서의 0-기준 행 번호 — 청크 반영 중에도 순서가 흔들리지 않게 명시한다. */
  index: number;
  bytes: Uint8Array;
  reasons: string[];
  values: FilledValue[];
  pages: number;
  failed: boolean;
}

export interface Highlight {
  x: number;
  y: number;
  w: number;
  h: number;
  key: string;
  value: string;
}

export interface RowPreview {
  /** **미검열 SVG** — 호출부가 `sanitizeSvg()`를 거쳐 DOM에 넣어야 한다(R7). */
  svg: string;
  pageW: number;
  pageH: number;
  highlights: Highlight[];
}

interface TableRef {
  section: number;
  block: number;
}
interface GridCell {
  row: number;
  col: number;
  text: string;
}
interface TableGrid {
  section: number;
  block: number;
  cells: GridCell[];
}
interface BlockHit {
  section: number;
  block: number;
  kind: string;
}

/** 배치 안에서 재사용하는 산출물 구조 캐시. 같은 양식·같은 영역이라 산출물의 표 목록은 행마다 같다
 *  (쪽수가 기준선과 다른 행은 구조가 흔들린 것이므로 **캐시를 쓰지 않고** 새로 훑는다 — 쪽수별로
 *  분리 보관하는 이유). 값 스캔은 "직전 행에서 값이 있던 표"부터 보고, 못 찾으면 전수 훑기로
 *  폴백한다 — 빠르지만 거짓 `value_not_found`를 만들지 않는다. */
export interface BatchCache {
  tablesByPages: Map<number, TableRef[]>;
  hint: TableRef[];
}

export function newBatchCache(): BatchCache {
  return { tablesByPages: new Map(), hint: [] };
}

/** 문서의 전 표 블록 결정론 열거(페이지 스캔). 073 함정 ②: 왕복 후 블록 인덱스가 재배열되므로
 *  산출물 검증은 주소 재사용이 아니라 **값 스캔**이고, 그 스캔의 후보 목록이 이것이다. */
export async function listTables(lane: EngineLane, pages: number): Promise<TableRef[]> {
  const out: TableRef[] = [];
  const seen = new Set<string>();
  for (let pg = 0; pg < pages; pg++) {
    const hits = (await lane.call<BlockHit[]>("blocksInRect", [pg, 0, 0, 100000, 100000])) ?? [];
    for (const h of hits) {
      const k = `${h.section}:${h.block}`;
      if (h.kind === "table" && !seen.has(k)) {
        seen.add(k);
        out.push({ section: h.section, block: h.block });
      }
    }
  }
  return out;
}

async function tablesFor(lane: EngineLane, pages: number, cache?: BatchCache): Promise<TableRef[]> {
  const hit = cache?.tablesByPages.get(pages);
  if (hit) return hit;
  const tables = await listTables(lane, pages);
  cache?.tablesByPages.set(pages, tables);
  return tables;
}

/** 값 하나가 산출물의 어느 표에 들어갔는지 — 힌트 표 우선, 없으면 전수. 찾으면 그 표를 돌려준다. */
async function findValueTable(lane: EngineLane, value: string, tables: TableRef[], hint: TableRef[]): Promise<TableRef | null> {
  const order = [...hint, ...tables.filter((t) => !hint.some((h) => h.section === t.section && h.block === t.block))];
  for (const t of order) {
    const grid = await lane.call<TableGrid | null>("tableGrid", [t.section, t.block]);
    if (grid?.cells.some((c) => c.text === value)) return { section: grid.section, block: grid.block };
  }
  return null;
}

function rememberHint(cache: BatchCache | undefined, t: TableRef) {
  if (!cache) return;
  if (!cache.hint.some((h) => h.section === t.section && h.block === t.block)) cache.hint.push(t);
}

export interface GenerateRowOptions {
  templateBytes: Uint8Array;
  templateName: string;
  targets: FillTarget[];
  row: Record<string, string>;
  /** 무편집 왕복 기준선 쪽수 — 이보다 늘면 `overflow:` 사유로 보고한다(CLI fill.rs와 한 벌). */
  basePages: number;
  cache?: BatchCache;
}

/** 한 사람분: 양식 열기 → 채움 → HWPX 산출 → **재개봉 검증**(쪽수·값 존재) 까지. 검수 SVG는
 *  만들지 않는다(캐러셀 진입 시 `renderRowPreview`). 던지는 예외는 호출부가 그 행만 접는다. */
export async function generateRow(lane: EngineLane, opts: GenerateRowOptions): Promise<Omit<RowCore, "index" | "failed">> {
  const { templateBytes, templateName, targets, row, basePages, cache } = opts;
  const reasons: string[] = [];
  const filled: FilledValue[] = [];

  await lane.open(templateBytes, templateName);
  for (const f of targets) {
    const value = (row[f.key] ?? "").trim();
    if (!value) {
      if (f.required) reasons.push(`missing_required:${f.key}`);
      continue;
    }
    const bad = f.formatError?.(value) ?? null;
    if (bad) reasons.push(`format_mismatch:${f.key}(${bad})`);
    try {
      await lane.call("applyIntent", [{ intent: "SetTableCell", section: f.pin.section, index: f.pin.index, row: f.pin.row, col: f.pin.col, text: value }]);
      filled.push({ key: f.key, value, addr: `s${f.pin.section}·b${f.pin.index}·r${f.pin.row}c${f.pin.col}`, example: f.example });
    } catch (e) {
      // 이 필드만 실패 — 나머지 필드는 계속 채운다(조용히 넘기지 않고 사유로 남긴다).
      reasons.push(`apply_failed:${f.key}:${describeError(e)}`);
    }
  }
  const bytes = await lane.call<Uint8Array>("toHwpx");

  // ── 재개봉 검증: 산출물을 다시 열어 쪽수와 값 존재를 확인한다(주소 재사용 금지 — 073 함정 ②).
  const { pages } = await lane.open(bytes, "check.hwpx");
  if (pages !== basePages) reasons.push(`overflow:pages_${pages}_vs_${basePages}`);
  if (filled.length) {
    const structural = pages === basePages ? cache : undefined; // 구조가 흔들린 행은 캐시를 믿지 않는다
    const tables = await tablesFor(lane, pages, structural);
    for (const f of filled) {
      const found = await findValueTable(lane, f.value, tables, structural?.hint ?? []);
      if (found) rememberHint(structural, found);
      else reasons.push(`value_not_found:${f.key}`);
    }
  }
  return { bytes, reasons, values: filled, pages };
}

/** 검수 캐러셀 진입 시에만 부르는 lazy 프리뷰: 산출물 바이트를 다시 열어 **채운 셀이 있는 한 페이지**만
 *  렌더하고 셀 경계 하이라이트를 만든다. N부 SVG를 전부 들고 있던 메모리 선형 증가를 없앤다. */
export async function renderRowPreview(lane: EngineLane, bytes: Uint8Array, values: FilledValue[]): Promise<RowPreview | null> {
  if (!bytes.length || !values.length) return null;
  const { pages } = await lane.open(bytes, "preview.hwpx");
  const tables = await listTables(lane, pages);
  const target = await findValueTable(lane, values[0].value, tables, []);
  if (!target) return null;
  for (let p = 0; p < pages; p++) {
    const hits = (await lane.call<BlockHit[]>("blocksInRect", [p, 0, 0, 100000, 100000])) ?? [];
    if (!hits.some((h) => h.section === target.section && h.block === target.block)) continue;
    const svg = await lane.call<string>("renderPageSvg", [p]);
    const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    const pageW = m ? parseFloat(m[1]) : 1;
    const pageH = m ? parseFloat(m[2]) : 1;
    const cols = await lane.call<number[] | null>("tableColBoundaries", [p, target.section, target.block]);
    const rows = await lane.call<number[] | null>("tableRowBoundaries", [p, target.section, target.block]);
    const highlights: Highlight[] = [];
    if (cols && rows) {
      const grid = await lane.call<TableGrid | null>("tableGrid", [target.section, target.block]);
      for (const f of values) {
        const cell = grid?.cells.find((c) => c.text === f.value);
        if (!cell || cell.col + 1 >= cols.length || cell.row + 1 >= rows.length) continue;
        highlights.push({ x: cols[cell.col], y: rows[cell.row], w: cols[cell.col + 1] - cols[cell.col], h: rows[cell.row + 1] - rows[cell.row], key: f.key, value: f.value });
      }
    }
    return { svg, pageW, pageH, highlights };
  }
  return null;
}

/** 무편집 왕복 기준선 쪽수 — .hwp 양식의 변환 리플로를 정직하게 반영한다(CLI fill.rs와 같은 규칙). */
export async function baselinePages(lane: EngineLane, templateBytes: Uint8Array, templateName: string): Promise<number> {
  await lane.open(templateBytes, templateName);
  const noEdit = await lane.call<Uint8Array>("toHwpx");
  const { pages } = await lane.open(noEdit, "baseline.hwpx");
  return pages;
}

export function describeError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const code = (e as { code?: string }).code;
    return code ? `${code}: ${String((e as { message: unknown }).message)}` : String((e as { message: unknown }).message);
  }
  return String(e);
}

function errorCode(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
}

/** wasm 트랩 / 워커 사망 = 인스턴스가 오염된 상태 — 다음 행을 위해 레인을 되살려야 한다(052 계보). */
export function isPoisoned(e: unknown): boolean {
  const code = errorCode(e);
  return code === "wasm_trap" || code === "worker_dead";
}

/** 의도적 종료(페이지 이탈·취소) — 배치를 중단한다. 크래시가 아니므로 실패 행으로 오염시키지 않는다. */
export function isTerminated(e: unknown): boolean {
  return errorCode(e) === "worker_terminated";
}

export interface BatchOptions {
  templateBytes: Uint8Array;
  templateName: string;
  targets: FillTarget[];
  rows: Record<string, string>[];
  basePages: number;
  /** 완성분을 화면에 반영하는 주기(행 수). 기본 8 — 진행률만이 아니라 결과 자체가 흘러들어온다. */
  chunkSize?: number;
  onChunk?: (done: RowCore[]) => void;
  onProgress?: (done: number, total: number) => void;
  /** 오염된 레인 복구(reset). 실패해도 배치는 계속 시도한다(다음 행이 또 실패할 뿐). */
  recover?: () => Promise<void>;
  /** 행 사이 양보. 워커 레인은 RPC 자체가 매크로태스크 경계라 불필요하지만, 폴백(메인스레드) 레인에서
   *  진행률이 다시 그려지려면 필요하다 — 비용은 행당 0.1ms 미만이라 항상 건다. */
  beforeRow?: () => Promise<void>;
}

export interface BatchResult {
  rows: RowCore[];
  /** 워커가 종료돼 중단된 배치 — 완성분은 그대로 살아 있다. */
  aborted: boolean;
}

/** 배치 전체. 행 격리 + 청크 반영 + 진행률 + 오염 복구를 한 곳에 모은다. */
export async function generateBatch(lane: EngineLane, opts: BatchOptions): Promise<BatchResult> {
  const { rows, chunkSize = 8, onChunk, onProgress, recover, beforeRow } = opts;
  const cache = newBatchCache();
  const out: RowCore[] = [];
  let sinceFlush = 0;
  let aborted = false;
  for (let i = 0; i < rows.length; i++) {
    onProgress?.(i, rows.length);
    await beforeRow?.();
    try {
      const core = await generateRow(lane, {
        templateBytes: opts.templateBytes,
        templateName: opts.templateName,
        targets: opts.targets,
        row: rows[i],
        basePages: opts.basePages,
        cache,
      });
      out.push({ index: i, ...core, failed: false });
    } catch (e) {
      if (isTerminated(e)) {
        aborted = true;
        break;
      }
      if (isPoisoned(e)) {
        try {
          await recover?.();
        } catch {
          /* 복구 실패 — 다음 행도 같은 사유로 접힐 뿐, 완성분은 보존된다 */
        }
      }
      out.push({ index: i, bytes: new Uint8Array(0), reasons: [`row_failed:${describeError(e)}`], values: [], pages: 0, failed: true });
    }
    sinceFlush++;
    if (sinceFlush >= chunkSize || i === rows.length - 1) {
      sinceFlush = 0;
      onChunk?.(out.slice());
    }
  }
  if (sinceFlush) onChunk?.(out.slice());
  onProgress?.(out.length, rows.length);
  return { rows: out, aborted };
}
