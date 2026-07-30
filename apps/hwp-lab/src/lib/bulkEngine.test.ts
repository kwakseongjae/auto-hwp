// 벌크 생성 파이프라인(073 2단계) 단위 잠금 — 가짜 레인 위에서 돈다(엔진·브라우저 무관).
// 잠그는 계약: 행 격리(row_failed) · 완성분 보존 · 청크 반영 · 진행률 · 재개봉 검증 3종(값·쪽수·형식) ·
// 오염(wasm_trap/worker_dead) 복구 후 계속 · 의도적 종료(worker_terminated)는 중단이지 실패가 아님 ·
// 산출물 구조 캐시가 RPC를 줄이되 거짓 value_not_found를 만들지 않음 · 검수 프리뷰 lazy 계산.
import { describe, expect, it, vi } from "vitest";
import {
  baselinePages,
  describeError,
  generateBatch,
  generateRow,
  isPoisoned,
  isTerminated,
  newBatchCache,
  renderRowPreview,
  type EngineLane,
  type FillTarget,
} from "./bulkEngine";

// ── 가짜 문서/레인 ────────────────────────────────────────────────────────────────────────────
// 표 2개(0쪽·1쪽)를 가진 2쪽 문서. 셀 텍스트는 Map. toHwpx = 상태 JSON 직렬화 → open 이 되살린다.
interface FakeDoc {
  pages: number;
  cells: Map<string, string>;
}
const KEY = (s: number, b: number, r: number, c: number) => `${s}:${b}:${r}:${c}`;
const TABLES = [
  { section: 0, block: 0, page: 0 },
  { section: 0, block: 4, page: 1 },
];

function templateDoc(): FakeDoc {
  const cells = new Map<string, string>();
  cells.set(KEY(0, 0, 0, 0), "기업명");
  cells.set(KEY(0, 0, 0, 1), "(예시) 홍길동상사");
  cells.set(KEY(0, 0, 1, 0), "연락처");
  cells.set(KEY(0, 0, 1, 1), "010-0000-0000");
  cells.set(KEY(0, 4, 0, 0), "비고");
  cells.set(KEY(0, 4, 0, 1), "");
  return { pages: 2, cells };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const encode = (d: FakeDoc) => enc.encode(JSON.stringify({ pages: d.pages, cells: [...d.cells] }));
function decode(bytes: Uint8Array): FakeDoc {
  const raw = JSON.parse(dec.decode(bytes)) as { pages: number; cells: [string, string][] };
  return { pages: raw.pages, cells: new Map(raw.cells) };
}

interface FakeOpts {
  /** 이 값이 들어오면 applyIntent 가 던진다(필드 단위 실패). */
  applyThrowsOn?: string;
  /** 이 값은 조용히 무시한다(채웠다고 믿지만 산출물에 없음 → value_not_found 여야 한다). */
  swallowValue?: string;
  /** 이 값이 들어오면 산출물 쪽수를 1 늘린다(오버플로 재현). */
  overflowOn?: string;
  /** 이 인덱스의 `toHwpx` 호출에서 통째로 던진다(행 실패). code 를 붙이면 오염/종료 재현. */
  failRows?: Map<number, { message: string; code?: string }>;
}

class FakeLane implements EngineLane {
  doc: FakeDoc | null = null;
  calls: string[] = [];
  rowSeq = -1; // toHwpx 호출 횟수 = 지금까지 시도한 행 수(기준선 제외)
  resets = 0;
  constructor(private opts: FakeOpts = {}) {}

  async open(bytes: Uint8Array): Promise<{ pages: number }> {
    this.calls.push("open");
    this.doc = decode(bytes);
    return { pages: this.doc.pages };
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push(method);
    const doc = this.doc;
    if (!doc) throw Object.assign(new Error("no document open"), { code: "no_document" });
    switch (method) {
      case "applyIntent": {
        const it = params[0] as { section: number; index: number; row: number; col: number; text: string };
        if (this.opts.applyThrowsOn === it.text) throw new Error("merged cell is not editable");
        if (this.opts.swallowValue !== it.text) doc.cells.set(KEY(it.section, it.index, it.row, it.col), it.text);
        if (this.opts.overflowOn === it.text) doc.pages += 1;
        return null as T;
      }
      case "toHwpx": {
        this.rowSeq += 1;
        const fail = this.opts.failRows?.get(this.rowSeq);
        if (fail) throw Object.assign(new Error(fail.message), fail.code ? { code: fail.code } : {});
        return encode(doc) as unknown as T;
      }
      case "blocksInRect": {
        const page = params[0] as number;
        const hits = TABLES.filter((t) => t.page === page).map((t) => ({ section: t.section, block: t.block, kind: "table" }));
        return [...hits, { section: 0, block: 99, kind: "paragraph" }] as unknown as T;
      }
      case "tableGrid": {
        const [section, block] = params as [number, number];
        const cells = [...doc.cells]
          .filter(([k]) => k.startsWith(`${section}:${block}:`))
          .map(([k, text]) => {
            const [, , r, c] = k.split(":").map(Number);
            return { row: r, col: c, text };
          });
        return { section, block, cells } as unknown as T;
      }
      case "renderPageSvg":
        return `<svg viewBox="0 0 595 842"><script>bad()</script></svg>` as unknown as T;
      case "tableColBoundaries":
        return [10, 100, 300] as unknown as T;
      case "tableRowBoundaries":
        return [10, 50, 90] as unknown as T;
      default:
        throw new Error(`unknown engine method: ${method}`);
    }
  }
}

const TPL = encode(templateDoc());
const target = (key: string, row: number, over: Partial<FillTarget> = {}): FillTarget => ({
  key,
  pin: { section: 0, index: 0, row, col: 1 },
  required: false,
  example: "",
  ...over,
});
const phone = (v: string) => (/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(v) ? null : `전화번호 형식 아님: "${v}"`);

const run = (lane: FakeLane, rows: Record<string, string>[], targets: FillTarget[], extra: Partial<Parameters<typeof generateBatch>[1]> = {}) =>
  generateBatch(lane, { templateBytes: TPL, templateName: "t.hwpx", targets, rows, basePages: 2, ...extra });

describe("073 2단계 — 한 사람분 생성 + 재개봉 검증", () => {
  it("채움 → 산출 → 재개봉에서 값이 실제로 발견된다(사유 0)", async () => {
    const lane = new FakeLane();
    const out = await generateRow(lane, {
      templateBytes: TPL,
      templateName: "t.hwpx",
      targets: [target("기업명", 0), target("연락처", 1)],
      row: { 기업명: "㈜다온소프트", 연락처: "010-2345-6789" },
      basePages: 2,
    });
    expect(out.reasons).toEqual([]);
    expect(out.values.map((v) => v.value)).toEqual(["㈜다온소프트", "010-2345-6789"]);
    expect(out.values[0].addr).toBe("s0·b0·r0c1");
    expect(decode(out.bytes).cells.get(KEY(0, 0, 0, 1))).toBe("㈜다온소프트");
    expect(out.pages).toBe(2);
  });

  it("필수 누락·형식 위반은 채우되 사유로 보고한다(조용한 통과 금지)", async () => {
    const lane = new FakeLane();
    const out = await generateRow(lane, {
      templateBytes: TPL,
      templateName: "t.hwpx",
      targets: [target("기업명", 0, { required: true }), target("연락처", 1, { formatError: phone })],
      row: { 연락처: "0102345" },
      basePages: 2,
    });
    expect(out.reasons).toEqual(["missing_required:기업명", `format_mismatch:연락처(전화번호 형식 아님: "0102345")`]);
    // 형식이 틀려도 값은 들어간다(3단 정책: 기본=생성+needsReview)
    expect(out.values).toHaveLength(1);
    expect(decode(out.bytes).cells.get(KEY(0, 0, 1, 1))).toBe("0102345");
  });

  it("쪽수가 기준선보다 늘면 overflow 로 보고한다", async () => {
    const lane = new FakeLane({ overflowOn: "길어진값" });
    const out = await generateRow(lane, { templateBytes: TPL, templateName: "t.hwpx", targets: [target("기업명", 0)], row: { 기업명: "길어진값" }, basePages: 2 });
    expect(out.reasons).toContain("overflow:pages_3_vs_2");
  });

  it("적용이 실패한 필드는 apply_failed, 조용히 삼켜진 값은 value_not_found 로 드러난다", async () => {
    const lane = new FakeLane({ applyThrowsOn: "터지는값", swallowValue: "사라지는값" });
    const out = await generateRow(lane, {
      templateBytes: TPL,
      templateName: "t.hwpx",
      targets: [target("기업명", 0), target("연락처", 1)],
      row: { 기업명: "터지는값", 연락처: "사라지는값" },
      basePages: 2,
    });
    expect(out.reasons[0]).toContain("apply_failed:기업명");
    expect(out.reasons).toContain("value_not_found:연락처");
  });

  it("구조 캐시가 두 번째 행부터 페이지 훑기를 없애되 값 스캔은 계속한다", async () => {
    const lane = new FakeLane();
    const cache = newBatchCache();
    const args = { templateBytes: TPL, templateName: "t.hwpx", targets: [target("기업명", 0)], basePages: 2, cache };
    await generateRow(lane, { ...args, row: { 기업명: "가" } });
    const firstScan = lane.calls.filter((c) => c === "blocksInRect").length;
    lane.calls.length = 0;
    const second = await generateRow(lane, { ...args, row: { 기업명: "나" } });
    expect(firstScan).toBe(2); // 2쪽 전수
    expect(lane.calls.filter((c) => c === "blocksInRect")).toHaveLength(0); // 캐시 적중
    expect(lane.calls.filter((c) => c === "tableGrid").length).toBeGreaterThan(0); // 값 스캔은 매 행
    expect(second.reasons).toEqual([]);
  });

  it("무편집 왕복 기준선은 산출물을 다시 열어 센다", async () => {
    const lane = new FakeLane();
    await expect(baselinePages(lane, TPL, "t.hwpx")).resolves.toBe(2);
  });
});

describe("073 2단계 — 배치(행 격리·청크 반영·복구)", () => {
  const rows = [{ 기업명: "가" }, { 기업명: "나" }, { 기업명: "다" }];
  const targets = [target("기업명", 0)];

  it("한 행이 죽어도 배치를 접지 않는다 — row_failed + 나머지 보존", async () => {
    const lane = new FakeLane({ failRows: new Map([[1, { message: "boom" }]]) });
    const res = await run(lane, rows, targets, { chunkSize: 1 });
    expect(res.aborted).toBe(false);
    expect(res.rows.map((r) => r.failed)).toEqual([false, true, false]);
    expect(res.rows[1].reasons[0]).toContain("row_failed:boom");
    expect(res.rows[1].bytes).toHaveLength(0);
    expect(res.rows[2].bytes.length).toBeGreaterThan(0);
    expect(res.rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("완성분을 청크로 흘려보내고 진행률을 갱신한다", async () => {
    const lane = new FakeLane();
    const chunks: number[] = [];
    const progress: [number, number][] = [];
    await run(lane, rows, targets, { chunkSize: 2, onChunk: (d) => chunks.push(d.length), onProgress: (done, total) => progress.push([done, total]) });
    expect(chunks).toEqual([2, 3]);
    expect(progress[0]).toEqual([0, 3]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it("wasm 트랩/워커 사망은 레인을 되살리고 다음 행을 계속한다", async () => {
    const lane = new FakeLane({ failRows: new Map([[0, { message: "unreachable", code: "wasm_trap" }]]) });
    const recover = vi.fn(async () => {
      lane.resets += 1;
    });
    const res = await run(lane, rows, targets, { recover });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(res.rows[0].failed).toBe(true);
    expect(res.rows.slice(1).every((r) => !r.failed)).toBe(true);
  });

  it("의도적 종료(worker_terminated)는 중단이지 실패 행이 아니다 — 완성분은 남는다", async () => {
    const lane = new FakeLane({ failRows: new Map([[2, { message: "terminated", code: "worker_terminated" }]]) });
    const res = await run(lane, rows, targets);
    expect(res.aborted).toBe(true);
    expect(res.rows).toHaveLength(2);
    expect(res.rows.every((r) => !r.failed)).toBe(true);
  });

  it("행 사이 양보 훅은 행마다 정확히 한 번 불린다(폴백 레인의 진행률 보장)", async () => {
    const lane = new FakeLane();
    const beforeRow = vi.fn(async () => {});
    await run(lane, rows, targets, { beforeRow });
    expect(beforeRow).toHaveBeenCalledTimes(3);
  });
});

describe("073 2단계 — 검수 프리뷰 lazy 생성", () => {
  it("채운 값이 있는 페이지만 렌더하고 셀 경계 하이라이트를 만든다", async () => {
    const lane = new FakeLane();
    const out = await generateRow(lane, { templateBytes: TPL, templateName: "t.hwpx", targets: [target("기업명", 0)], row: { 기업명: "㈜다온소프트" }, basePages: 2 });
    const p = await renderRowPreview(lane, out.bytes, out.values);
    expect(p).not.toBeNull();
    expect(p!.pageW).toBe(595);
    expect(p!.pageH).toBe(842);
    expect(p!.highlights).toEqual([{ x: 100, y: 10, w: 200, h: 40, key: "기업명", value: "㈜다온소프트" }]);
    // 미검열 SVG 그대로 돌려준다 — 검열은 호출부(sanitizeSvg)의 책임이라는 계약.
    expect(p!.svg).toContain("<script>");
  });

  it("채운 값이 없으면 프리뷰를 만들지 않는다(빈 바이트도 마찬가지)", async () => {
    const lane = new FakeLane();
    await expect(renderRowPreview(lane, TPL, [])).resolves.toBeNull();
    await expect(renderRowPreview(lane, new Uint8Array(0), [{ key: "k", value: "v", addr: "", example: "" }])).resolves.toBeNull();
  });
});

describe("073 2단계 — 오류 분류", () => {
  it("코드가 붙은 오류는 코드까지 보고한다", () => {
    expect(describeError(Object.assign(new Error("boom"), { code: "wasm_trap" }))).toBe("wasm_trap: boom");
    expect(describeError("plain")).toBe("plain");
  });

  it("오염(wasm_trap/worker_dead)과 종료(worker_terminated)를 구분한다", () => {
    expect(isPoisoned({ code: "wasm_trap" })).toBe(true);
    expect(isPoisoned({ code: "worker_dead" })).toBe(true);
    expect(isPoisoned({ code: "worker_terminated" })).toBe(false);
    expect(isTerminated({ code: "worker_terminated" })).toBe(true);
    expect(isTerminated(new Error("x"))).toBe(false);
  });
});
