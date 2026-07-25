// 본문 문단 글자 캐럿 (CARET-GAP §7.4 P2의 UI측 해소) — 순수 헬퍼 + 헤드리스 컨트롤러. DOM 무의존.
//
// ## 왜 셀 캐럿(053)과 다른 길을 가는가 — 엔진 표면 실측
// 053은 `HitTestCell`/`CaretRectCell`(own-render `place.rs` 재구동)로 셀 캐럿을 얻는다. 본문 문단에는
// 그 짝이 **없다**:
//   · `Intent::HitTest`/`CaretRect`(rhwp 글리프 박스, NodeId 주소)는 바이너리 .hwp 문단에 stable_key가
//     없어 `node:null`로 떨어지고(CARET-GAP §2.1), 좌표계도 own-render와 어긋난다(§7.2 — 실측: 본문
//     문단 밴드 위의 점이 rhwp에서는 `in_cell:true`로 나온다). 화면 위에 얹을 수 없는 좌표다.
//   · `PlacedGlyph`에는 provenance가 없다(place.rs 주석) → 엔진이 "이 글리프는 (section,block)의 몇 번째
//     글자"를 알려주는 표면 자체가 없다.
// 대신 **화면에 실제로 그려진 것**을 캐럿 기하의 정본으로 삼는다:
//   · `hitTest`(own_hit_test) → 문단 밴드 `(section, block, x/y/w/h, editable)` = 주소 + 세로 범위,
//   · `pageSvg`(뷰가 주입하는 바로 그 문자열) → 글리프별 `x`/baseline/size,
//   · `blockRuns(section, block)` → 모델 텍스트/스타일,
//   · `SetParagraphRuns` → 런 보존 커밋(평문 variant 금지 — 불변식 5).
// 렌더러는 글리프 1개당 `<text>` 1개를 쓰고 **공백만 건너뛴다**(hwp-render `ch.is_whitespace()`), 그래서
// "밴드 안 글리프 수 == 모델 텍스트의 비공백 문자 수"가 성립하면 정렬은 1:1로 확정된다. 이 등식이
// 깨지면(문단이 페이지 경계에서 쪼개진 경우 등) 캐럿을 **주지 않는다**(018 null 정책 — 틀린 캐럿 금지).
// 벤치마크 4종 실측: 텍스트 있는 본문 문단 밴드 382개 중 379개(99.2%) 정렬 성공, 오정렬 0.
//
// ## 좌표/규약 (셀 캐럿과 동일하게 맞춘 것 — 실측으로 확인)
//   · caret.x   = 그 글자의 advance 박스 왼쪽 = `<text>`의 x (문단 끝은 마지막 글자 x + advance)
//   · caret.top = baseline − height × 0.85 (hwp-typeset `BASELINE_RATIO`)
//   · height    = 그 줄의 최대 글리프 size (실측: cellCaretRect.height / glyph size = 1.000)
// 공백 문자의 x는 그릴 글리프가 없으므로 **관측된 advance로 자가 보정**해 채운다(§`calibrate`).

import type { EngineAdapter } from "./adapter";
import { clampOffset } from "./caret";
import { type RangeRect, rectsFromCharBoxes, selRange } from "./caretRange";
import { inheritStyleAt, rangeHasStyle, runsText, spliceRuns, styleRunRange, type ToggleKey } from "./cellCaret";
import { Emitter } from "./events";
import type { RunStyle } from "./runs";
import type { DocSession } from "./session";
import type { BlockHit, CellCaretRect, Intent, RunSpec } from "./types";

/** hwp-typeset `BASELINE_RATIO` — 줄 높이에서 베이스라인이 차지하는 비율(한컴 850/1000 규약). */
const BASELINE_RATIO = 0.85;
/** 폴백 advance 비율(EM 대비): 관측 표본이 없을 때만 쓴다. 전각(한글/한자/가나) vs 반각. */
const FALLBACK_ADV_WIDE = 1.0;
const FALLBACK_ADV_NARROW = 0.5;
/** 폴백 공백 advance 비율 — hwp-typeset의 `SPACE` 상수와 같은 값(EM의 0.3). */
const FALLBACK_SPACE = 0.3;
/** 같은 줄로 묶는 baseline 허용 오차(px). SVG는 소수 2자리로 반올림되므로 여유를 조금 준다. */
const BASELINE_EPS = 0.05;

/** 페이지 SVG에서 읽어낸 글리프 하나 — own-render 페이지 px. */
export interface PageGlyph {
  /** advance 박스의 왼쪽 x. */
  x: number;
  /** 베이스라인 y (`<text>`의 y). */
  baseline: number;
  /** 글리프 EM 크기(px). */
  size: number;
  /** 그려진 문자열(보통 1글자; 옛한글은 첫가끝 클러스터 — 어느 쪽이든 모델 문자 1개에 대응). */
  text: string;
}

/** 모델 문자 1개의 화면 위 자리 — 캐럿 기하의 최소 단위. */
export interface CharBox {
  /** 글자의 advance 박스 왼쪽 x (= 이 글자 앞에 캐럿을 놓을 위치). */
  x: number;
  /** 이 글자의 advance 폭. 비공백은 관측값(다음 글리프와의 차) 우선, 아니면 보정 비율. */
  adv: number;
  /** 이 글자가 놓인 줄의 베이스라인 y. */
  baseline: number;
  /** 이 글자가 놓인 줄의 높이(그 줄 최대 글리프 size) — 캐럿 높이. */
  lineHeight: number;
  /** 0부터 매긴 줄 번호(같은 baseline = 같은 줄). */
  line: number;
}

// ── 순수 헬퍼 ────────────────────────────────────────────────────────────────────────────────────

const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
const TEXT_RE = /<text\s([^>]*)>([^<]*)<\/text>/g;

/** XML 엔티티 되돌리기 — 렌더러 `esc()`가 쓰는 4종만(그 외는 그대로 나온다). */
function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** 페이지 SVG 문자열에서 글리프를 전부 뽑는다(속성 순서에 의존하지 않는 파싱). 좌표는 own-render px —
 *  뷰가 주입하는 바로 그 문자열이므로 화면과 정의상 일치한다. */
export function parsePageGlyphs(svg: string): PageGlyph[] {
  const out: PageGlyph[] = [];
  TEXT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEXT_RE.exec(svg))) {
    const attrs = m[1];
    let x = NaN;
    let y = NaN;
    let size = NaN;
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(attrs))) {
      if (a[1] === "x") x = parseFloat(a[2]);
      else if (a[1] === "y") y = parseFloat(a[2]);
      else if (a[1] === "font-size") size = parseFloat(a[2]);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, baseline: y, size: Number.isFinite(size) ? size : 0, text: unescapeXml(m[2]) });
  }
  return out;
}

/** 문단 밴드(`hitTest`의 y/h) 안에 baseline이 들어오는 글리프만, 읽기 순서((baseline, x))로.
 *  밴드는 top-level 블록의 세로 띠라 이웃 블록의 글리프를 삼키지 않는다(실측: 오염 0건). */
export function glyphsInBand(glyphs: PageGlyph[], band: { y: number; h: number }): PageGlyph[] {
  return glyphs
    .filter((g) => g.baseline > band.y && g.baseline <= band.y + band.h + 0.5)
    .sort((a, b) => a.baseline - b.baseline || a.x - b.x);
}

/** 전각(한 EM을 다 쓰는) 문자인가 — advance 보정 표본을 폭 계열별로 나누기 위한 최소 분류. */
function isWide(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x11ff) || // 한글 자모
    (c >= 0x2e80 && c <= 0xa4cf) || // CJK 부수 ~ 이(Yi)
    (c >= 0xac00 && c <= 0xd7a3) || // 한글 음절
    (c >= 0xf900 && c <= 0xfaff) || // CJK 호환 한자
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) || // 전각 형태
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

const isWs = (ch: string) => /\s/.test(ch);

/** 관측된 글리프 간격에서 advance 비율을 **자가 보정**한다. 폰트가 주입되면(웹 셸의 NanumGothic) 엔진
 *  metrics가 통째로 바뀌므로 상수를 박으면 틀린다 — 같은 줄의 인접 글리프 간격에서 직접 뽑는다.
 *  · 사이에 공백이 0개인 쌍 → 그 글자의 advance 표본(전각/반각별)
 *  · 사이에 공백이 k개인 쌍 → (간격 − 글자 advance) / k = 공백 advance 표본 */
function calibrate(text: string, glyphs: PageGlyph[], modelIdx: number[], lineOf: number[]) {
  const wide: number[] = [];
  const narrow: number[] = [];
  const pairs: { gap: number; k: number; ch: string; size: number }[] = [];
  for (let i = 0; i + 1 < glyphs.length; i++) {
    if (lineOf[i] !== lineOf[i + 1]) continue; // 줄이 바뀌면 x 간격은 advance가 아니다
    const size = glyphs[i].size || glyphs[i + 1].size;
    if (!(size > 0)) continue;
    const gap = glyphs[i + 1].x - glyphs[i].x;
    if (!(gap > 0)) continue;
    const k = modelIdx[i + 1] - modelIdx[i] - 1; // 사이에 낀 공백 문자 수
    const ch = text[modelIdx[i]];
    if (k === 0) (isWide(ch) ? wide : narrow).push(gap / size);
    else pairs.push({ gap, k, ch, size });
  }
  const advWide = median(wide) ?? FALLBACK_ADV_WIDE;
  const advNarrow = median(narrow) ?? FALLBACK_ADV_NARROW;
  const advRatio = (ch: string) => (isWide(ch) ? advWide : advNarrow);
  const spaceSamples = pairs
    .map((p) => (p.gap - advRatio(p.ch) * p.size) / (p.k * p.size))
    .filter((r) => r > 0.02 && r < 1.5);
  const spaceRatio = median(spaceSamples) ?? FALLBACK_SPACE;
  return { advRatio, spaceRatio };
}

/** 모델 텍스트 ↔ 밴드 글리프 1:1 정렬 → 문자별 화면 자리. 정렬 불가면 **null**(018: 틀린 캐럿보다 무캐럿).
 *  불가 조건: 글리프 수 ≠ 비공백 문자 수(문단이 페이지 경계에서 쪼개졌거나 렌더 규약이 바뀐 경우). */
export function alignCharBoxes(text: string, glyphs: PageGlyph[]): CharBox[] | null {
  if (glyphs.length === 0 || text.length === 0) return null;
  const modelIdx: number[] = []; // 글리프 k ↔ 모델 문자 인덱스
  for (let i = 0; i < text.length; i++) if (!isWs(text[i])) modelIdx.push(i);
  if (modelIdx.length !== glyphs.length) return null;

  // 줄 번호 매기기(정렬된 baseline이 바뀌는 지점이 줄 경계) + 줄 높이 = 그 줄 최대 글리프 size.
  const lineOf: number[] = [];
  const lineBaseline: number[] = [];
  const lineHeight: number[] = [];
  for (let k = 0; k < glyphs.length; k++) {
    const g = glyphs[k];
    if (k === 0 || Math.abs(g.baseline - lineBaseline[lineBaseline.length - 1]) > BASELINE_EPS) {
      lineBaseline.push(g.baseline);
      lineHeight.push(g.size);
    } else if (g.size > lineHeight[lineHeight.length - 1]) {
      lineHeight[lineHeight.length - 1] = g.size;
    }
    lineOf.push(lineBaseline.length - 1);
  }

  const { advRatio, spaceRatio } = calibrate(text, glyphs, modelIdx, lineOf);
  const boxes: CharBox[] = new Array(text.length);
  const put = (i: number, x: number, adv: number, line: number) => {
    boxes[i] = { x, adv, baseline: lineBaseline[line], lineHeight: lineHeight[line], line };
  };

  // 글리프를 따라가며 커서를 전진시킨다. 비공백은 글리프 x로 **스냅**(정확), 공백은 보정 advance로 채운다.
  let cursor = glyphs[0].x;
  let prevSize = glyphs[0].size || 1;
  let k = 0; // 다음 글리프
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (k < glyphs.length && modelIdx[k] === i) {
      const g = glyphs[k];
      const line = lineOf[k];
      const size = g.size || prevSize;
      // 다음 글리프가 같은 줄이고 사이에 공백이 없으면 그 간격이 이 글자의 실제 advance다.
      const next = k + 1 < glyphs.length && lineOf[k + 1] === line && modelIdx[k + 1] === i + 1 ? glyphs[k + 1] : null;
      const adv = next ? next.x - g.x : advRatio(ch) * size;
      put(i, g.x, adv, line);
      cursor = g.x + adv;
      prevSize = size;
      k++;
      continue;
    }
    // 공백: 그릴 글리프가 없다.
    //  · 문단 선두 공백(아직 글리프를 하나도 안 지남) → 첫 글리프 x에서 **왼쪽으로 역산**(들여쓰기 자리).
    //  · 그 외(줄 끝의 줄바꿈 공백 포함) → 직전 글자의 오른쪽 끝(cursor)부터 채운다. 줄바꿈에서 먹힌
    //    공백을 다음 줄 왼쪽 여백에 그리면 캐럿이 본문 밖으로 튀므로, 앞 줄 끝에 붙이는 쪽이 옳다.
    const line = k === 0 ? lineOf[0] : lineOf[k - 1];
    const size = (k < glyphs.length ? glyphs[k].size : 0) || prevSize;
    const spaceAdv = spaceRatio * size;
    if (k === 0) {
      let n = 0;
      for (let j = i; j < text.length && modelIdx[0] !== j; j++) n++;
      let x = glyphs[0].x - n * spaceAdv;
      for (let j = 0; j < n; j++, i++) {
        put(i, x, spaceAdv, line);
        x += spaceAdv;
      }
      i--; // 바깥 for 루프의 i++ 보정 — 다음 회차가 첫 글리프의 문자에서 시작하도록
      cursor = glyphs[0].x;
      continue;
    }
    put(i, cursor, spaceAdv, line);
    cursor += spaceAdv;
  }
  // 방어: 한 글자라도 자리를 못 받았으면(있어선 안 될 경로) 캐럿을 만들지 않는다 — 018.
  for (const b of boxes) if (!b) return null;
  return boxes;
}

/** 글리프가 **하나도 없는** 문단(빈 문단 / 공백만 있는 문단 / Enter 로 갓 생긴 문단)의 문자 박스.
 *  근거는 밴드뿐이다: 줄 왼쪽 = `band.x`, 줄 높이 = `band.h`(그 문단이 차지한 한 줄). 실제 글자가 하나라도
 *  생기면 다음 `resolve`에서 글리프 정렬(정확한 경로)로 자동 승격된다 — 이 박스는 "빈 줄에 캐럿을 세우는"
 *  최소 근사일 뿐이고, 그래서 폭(adv)은 0이다. */
export function emptyParaBoxes(band: { x: number; y: number; h: number }, count = 1): CharBox[] {
  if (!(band.h > 0)) return [];
  const box: CharBox = { x: band.x, adv: 0, baseline: band.y + band.h * BASELINE_RATIO, lineHeight: band.h, line: 0 };
  // 모델 글자 수만큼(공백만 있는 문단) 같은 자리를 복제한다 — 오프셋 클램프와 커밋 좌표가 모델과 어긋나지
  // 않게. 어차피 폭이 0이라 캐럿은 한 자리에 머문다(보이지 않는 공백 위에서 정직한 동작).
  return Array.from({ length: Math.max(1, count) }, () => ({ ...box }));
}

/** 오프셋 → 캐럿 사각형. `offset == 길이`(문단 끝)는 마지막 글자의 오른쪽 끝. 셀 캐럿과 동일 규약:
 *  past-end는 **클램프**되어 사각형을 돌려준다(null 아님). 박스가 없으면 null. */
export function bodyCaretRectAt(boxes: CharBox[], offset: number, page: number): CellCaretRect | null {
  if (boxes.length === 0) return null;
  const o = clampOffset(offset, boxes.length);
  const b = o < boxes.length ? boxes[o] : boxes[boxes.length - 1];
  const x = o < boxes.length ? b.x : b.x + b.adv;
  return { page, x, top: b.baseline - b.lineHeight * BASELINE_RATIO, height: b.lineHeight };
}

/** 줄 하나 안에서 x에 가장 가까운 글자 경계. 글자 중앙보다 왼쪽이면 그 앞, 아니면 뒤. */
function offsetInLine(boxes: CharBox[], line: number, x: number): number {
  let first = -1;
  let last = -1;
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].line !== line) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return 0;
  for (let i = first; i <= last; i++) {
    const b = boxes[i];
    if (x < b.x + b.adv / 2) return i;
  }
  return last + 1;
}

/** 페이지 px 클릭 → 문단 안 글자 오프셋. 줄은 y가 든 줄, 없으면 **가장 가까운** 줄(`block_at`의 근접
 *  스냅 규칙과 같은 정신). 줄 안에서는 글자 경계로 스냅한다. */
export function bodyOffsetAtPoint(boxes: CharBox[], x: number, y: number): number {
  if (boxes.length === 0) return 0;
  const lines = new Map<number, CharBox>();
  for (const b of boxes) if (!lines.has(b.line)) lines.set(b.line, b);
  let best = -1;
  let bestDist = Infinity;
  for (const [line, b] of lines) {
    const top = b.baseline - b.lineHeight * BASELINE_RATIO;
    if (y >= top && y <= top + b.lineHeight) return offsetInLine(boxes, line, x);
    const d = y < top ? top - y : y - (top + b.lineHeight);
    if (d < bestDist) {
      bestDist = d;
      best = line;
    }
  }
  return offsetInLine(boxes, best, x);
}

/** 위/아래 방향키: 같은 x를 유지한 채 이웃 줄로. 이동할 줄이 없으면 오프셋 그대로(클램프). */
export function bodyLineMove(boxes: CharBox[], offset: number, delta: number): number {
  if (boxes.length === 0) return 0;
  const o = clampOffset(offset, boxes.length);
  const cur = o < boxes.length ? boxes[o] : boxes[boxes.length - 1];
  const x = o < boxes.length ? cur.x : cur.x + cur.adv;
  const target = cur.line + delta;
  if (!boxes.some((b) => b.line === target)) return o;
  return offsetInLine(boxes, target, x);
}

// ── 컨트롤러 ──────────────────────────────────────────────────────────────────────────────────────

/** 본문 캐럿의 모델 절반: 문단 주소 + 그 안의 오프셋. (셀 캐럿의 `CellCaretAnchor` 대응) */
export interface BodyCaretAnchor {
  section: number;
  block: number;
  /** 문단 텍스트 안의 char 오프셋, `0..=paraLen`. 선택의 **이동단**(focus). */
  offset: number;
  /** 선택 범위의 **고정단**(anchor) — 셀 캐럿과 같은 규약(caretRange.ts). `offset` 과 같으면 범위 없음. */
  selAnchor: number;
  /** 문단의 char 수 — 캐럿 이동의 클램프 한계. */
  paraLen: number;
}

/** 살아 있는 본문 캐럿: 모델 앵커 + 기하(own-render 페이지 px + 그 페이지). */
export interface BodyCaretState {
  anchor: BodyCaretAnchor;
  rect: CellCaretRect;
  /** 선택 범위의 줄별 하이라이트(범위가 없으면 빈 배열). */
  rects: RangeRect[];
}

/// BodyCaretController — 본문 문단 캐럿의 헤드리스 절반. 셀 캐럿(053)과 같은 계약:
///  1. null 정책(018) — 텍스트 밖 클릭/정렬 실패/주소 미해소는 전부 `null`, throw 없음.
///  2. 클램프 — 오프셋은 항상 `[0, paraLen]`.
///  3. 커밋은 오직 `SetParagraphRuns`(런 보존 variant — 불변식 5), 키 하나 = undo 하나,
///     `DocSession.applyBatch` 경유(레이아웃 무효화/undo 장부 일관).
/// 모든 비동기 진입점은 CHAIN되어 빠른 연타에서도 순서가 보장된다.
export class BodyCaretController {
  private state: BodyCaretState | null = null;
  private changed = new Emitter<BodyCaretState | null>();
  private chain: Promise<unknown> = Promise.resolve();
  /** 현재 문단의 문자 박스 캐시 — 방향키 이동은 이걸로 즉답(엔진 왕복 0). 커밋 때 갱신된다. */
  private boxes: CharBox[] | null = null;
  private page = 0;

  constructor(
    private adapter: EngineAdapter,
    private session: DocSession,
  ) {}

  /** 이 백엔드가 본문 캐럿을 답할 수 있는가(018: 없는 메서드 = 기능 off). */
  get supported(): boolean {
    // `hitTest`/`pageSvg`는 EngineAdapter 필수 멤버라 선택적인 `blockRuns` 유무가 곧 지원 여부다.
    return !!this.adapter.blockRuns;
  }

  get(): BodyCaretState | null {
    return this.state;
  }

  onChange(l: (s: BodyCaretState | null) => void): () => void {
    return this.changed.on(l);
  }

  /** 캐럿 제거(Escape / 포커스 상실 / 문서 교체). 실제로 지워질 때만 emit. */
  clear(): void {
    this.boxes = null;
    if (this.state) {
      this.state = null;
      this.changed.emit(null);
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** 문단 밴드 + 모델 텍스트 + 페이지 SVG를 읽어 문자 박스를 만든다. 정렬 실패 = null(018).
   *  **글리프가 없는 문단**(빈 문단 / Enter 로 갓 생긴 문단)은 밴드 하나로 빈 줄 박스를 만든다 — 그래야
   *  Enter 뒤에도 캐럿이 남는다(글자가 생기는 순간 글리프 정렬로 승격). */
  private async resolve(page: number, band: BlockHit): Promise<{ boxes: CharBox[]; runs: RunSpec[]; text: string } | null> {
    const runs = await this.adapter.blockRuns!(band.section, band.block);
    const text = runsText(runs);
    if (text.trim().length === 0) {
      const boxes = emptyParaBoxes(band, text.length);
      return boxes.length ? { boxes, runs, text } : null;
    }
    const svg = await this.adapter.pageSvg(page);
    const boxes = alignCharBoxes(text, glyphsInBand(parsePageGlyphs(svg), band));
    if (!boxes) return null;
    return { boxes, runs, text };
  }

  /** 편집 가능한 **본문 문단** 밴드만 통과시킨다. 표/그림/구조 문단은 이 캐럿의 대상이 아니다.
   *  `own_hit_test`는 빈 곳을 눌러도 가장 가까운 밴드를 돌려주므로(근접 스냅), 클릭 y가 밴드 **안**일
   *  때만 캐럿을 준다 — 여백 클릭이 엉뚱한 문단에 캐럿을 남기지 않게. */
  private bandFor(hit: BlockHit | null, y: number): BlockHit | null {
    if (!hit || hit.kind !== "paragraph" || !hit.editable) return null;
    if (y < hit.y || y > hit.y + hit.h) return null;
    return hit;
  }

  /** 페이지 로컬 px 클릭 → 본문 캐럿. 본문 텍스트가 아니면 `null`(+ 캐럿 해제).
   *  `extend`(Shift+클릭)는 **같은 문단** 안이면 고정단을 유지해 범위를 만든다(다른 문단이면 새 캐럿 —
   *  문단을 넘는 범위는 커밋 대상이 하나가 아니라 v1 밖). */
  clickAt(page: number, x: number, y: number, extend = false): Promise<BodyCaretState | null> {
    if (!this.supported) return Promise.resolve(null);
    return this.enqueue(async () => {
      const band = this.bandFor((await this.adapter.hitTest(page, x, y)) ?? null, y);
      if (!band) {
        this.clear();
        return null;
      }
      const geo = await this.resolve(page, band);
      if (!geo) {
        this.clear();
        return null;
      }
      const prev = extend ? this.state?.anchor : undefined;
      const same = prev && prev.section === band.section && prev.block === band.block;
      const offset = bodyOffsetAtPoint(geo.boxes, x, y);
      this.boxes = geo.boxes;
      this.page = page;
      this.emit({
        section: band.section,
        block: band.block,
        offset,
        selAnchor: same ? clampOffset(prev!.selAnchor, geo.text.length) : offset,
        paraLen: geo.text.length,
      });
      return this.state;
    });
  }

  /** 좌우 방향키: 문단 안에서 `delta`만큼. 기하는 캐시된 박스로 즉답(엔진 왕복 없음).
   *  범위가 살아 있으면 한 칸 움직이는 대신 **가까운 끝으로 접힌다**(워드프로세서 관례). */
  move(delta: number): Promise<BodyCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.boxes) return null;
      const { start, end } = selRange(a.selAnchor, a.offset);
      const offset = end > start && delta !== 0 ? (delta < 0 ? start : end) : clampOffset(a.offset + delta, a.paraLen);
      this.emit({ ...a, offset, selAnchor: offset });
      return this.state;
    });
  }

  /** 위/아래 방향키: 같은 x를 유지한 채 이웃 줄로(한 줄 문단이면 제자리). 범위는 접힌다. */
  moveLine(delta: number): Promise<BodyCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.boxes) return null;
      const offset = bodyLineMove(this.boxes, a.offset, delta);
      this.emit({ ...a, offset, selAnchor: offset });
      return this.state;
    });
  }

  /** Shift+←/→ — 고정단은 두고 이동단만 옮긴다(범위 확장/축소). */
  extend(delta: number): Promise<BodyCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.boxes) return null;
      this.emit({ ...a, offset: clampOffset(a.offset + delta, a.paraLen) });
      return this.state;
    });
  }

  /** Shift+↑/↓ — 줄 단위 범위 확장(같은 x 유지). */
  extendLine(delta: number): Promise<BodyCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.boxes) return null;
      this.emit({ ...a, offset: bodyLineMove(this.boxes, a.offset, delta) });
      return this.state;
    });
  }

  /** ⌘A — 이 문단 전체 선택(캐럿의 편집 단위가 문단 하나라 문서 전체가 아니다). */
  selectAll(): Promise<BodyCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.boxes) return null;
      this.emit({ ...a, selAnchor: 0, offset: a.paraLen });
      return this.state;
    });
  }

  /** 캐럿에 글자 삽입 — `SetParagraphRuns` 하나 = undo 하나(키 입력 커밋 레인).
   *  범위가 있으면 그 범위를 **대체**한다. */
  insertText(text: string): Promise<boolean> {
    return this.enqueue(() => this.splice(text, 0));
  }

  /** 백스페이스: 범위가 있으면 범위 삭제, 없으면 캐럿 **앞** 한 글자 삭제.
   *  문단 맨 앞이면 **앞 문단과 병합**(`MergeParagraph`) — 앞이 표/구조 문단이면 엔진이 거절하고 no-op. */
  deleteBack(): Promise<boolean> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (a && a.selAnchor === a.offset && a.offset === 0) return this.mergeBack();
      return this.splice("", 1);
    });
  }

  /** Enter — 캐럿 자리에서 문단을 둘로 나눈다(`SplitParagraph` 하나 = undo 하나). 범위가 있으면 먼저
   *  그 범위를 지우고 나눈다(워드프로세서 관례)… 는 두 번의 커밋이 되므로 v1은 **범위를 지운 뒤 나누는
   *  것을 한 배치**로 보낸다(undo 하나). 커밋 뒤 캐럿은 새 문단의 맨 앞으로 간다. */
  splitParagraph(): Promise<boolean> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.supported) return false;
      const runs = await this.adapter.blockRuns!(a.section, a.block);
      const text = runsText(runs);
      const { start, end } = selRange(a.selAnchor, a.offset);
      const at = clampOffset(end > start ? start : a.offset, text.length);
      const batch: Intent[] = [];
      if (end > start) {
        // 범위를 먼저 지운다 — 같은 배치라 undo 하나로 둘 다 되돌아간다.
        batch.push({ intent: "SetParagraphRuns", section: a.section, block: a.block, runs: spliceRuns(runs, end, end - start, "") });
      }
      batch.push({ intent: "SplitParagraph", section: a.section, block: a.block, at });
      await this.session.applyBatch(batch);
      // 새 문단은 block + 1, 캐럿은 그 맨 앞. 밴드를 다시 찾아 기하를 잡는다(실패하면 캐럿만 사라진다).
      await this.reanchor(a.section, a.block + 1, 0);
      return true;
    });
  }

  /** ⌘B/⌘I 등 — 선택 범위에만 굵게/기울임/밑줄/취소선 토글. 같은 `SetParagraphRuns` 레인(undo 하나). */
  toggleStyle(key: ToggleKey): Promise<boolean> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.supported) return false;
      const { start, end } = selRange(a.selAnchor, a.offset);
      if (end <= start) return false;
      const runs = await this.adapter.blockRuns!(a.section, a.block);
      const on = !rangeHasStyle(runs, start, end, key);
      await this.session.applyBatch([
        { intent: "SetParagraphRuns", section: a.section, block: a.block, runs: styleRunRange(runs, start, end, key, on) },
      ]);
      // 서식은 글자 폭을 바꾼다 → 기하를 다시 잡되 **선택은 유지**한다(연속 ⌘B/⌘I 가 가능하게).
      await this.reanchor(a.section, a.block, a.offset, a.selAnchor);
      return true;
    });
  }

  /** 캐럿 자리에서 입력/조합될 텍스트가 물려받을 런 스타일(059 IME 미리보기 소스). 읽기 전용. */
  async styleAtCaret(): Promise<RunStyle | null> {
    const a = this.state?.anchor;
    if (!a || !this.supported) return null;
    const runs = await this.adapter.blockRuns!(a.section, a.block);
    return inheritStyleAt(runs, a.offset);
  }

  private emit(anchor: BodyCaretAnchor): void {
    const rect = this.boxes ? bodyCaretRectAt(this.boxes, anchor.offset, this.page) : null;
    if (!rect) {
      this.clear();
      return;
    }
    const { start, end } = selRange(anchor.selAnchor, anchor.offset);
    const rects = this.boxes ? rectsFromCharBoxes(this.boxes, start, end, this.page) : [];
    this.state = { anchor, rect, rects };
    this.changed.emit(this.state);
  }

  /** 커밋 뒤 공용 재앵커: 문단 밴드를 다시 찾고(페이지가 바뀌었을 수 있다) 기하를 새로 만든 뒤 캐럿을
   *  `offset`(고정단은 `selAnchor` ?? offset)에 세운다. 못 찾으면 **편집은 서고 캐럿만 사라진다**(018). */
  private async reanchor(section: number, block: number, offset: number, selAnchor?: number): Promise<void> {
    const from = this.state?.rect ?? { page: this.page, x: 0, top: 0, height: 1 };
    const found = await this.reband(section, block, this.page, from);
    if (!found) {
      this.clear();
      return;
    }
    const geo = await this.resolve(found.page, found.band);
    if (!geo) {
      this.clear();
      return;
    }
    this.boxes = geo.boxes;
    this.page = found.page;
    const at = clampOffset(offset, geo.text.length);
    this.emit({ section, block, offset: at, selAnchor: clampOffset(selAnchor ?? at, geo.text.length), paraLen: geo.text.length });
  }

  /** 문단 첫머리 Backspace = 앞 문단과 병합(`MergeParagraph`). 앞 블록이 표/그림/구조 문단이면 엔진이
   *  거절하므로 **조용한 no-op**(false) — 캐럿은 그대로 둔다. 병합 뒤 캐럿은 이어붙은 자리에 선다. */
  private async mergeBack(): Promise<boolean> {
    const a = this.state?.anchor;
    if (!a || !this.supported || a.block === 0) return false;
    // 앞 문단의 길이를 미리 읽어 둔다 — 병합 후 캐럿이 설 자리(이어붙은 이음매)다. 앞이 문단이 아니면
    // 여기서 실패하거나 빈 배열이 오고, 어느 쪽이든 아래 커밋이 엔진에서 거절된다.
    let prevLen = 0;
    try {
      prevLen = runsText(await this.adapter.blockRuns!(a.section, a.block - 1)).length;
    } catch {
      return false;
    }
    try {
      await this.session.applyBatch([{ intent: "MergeParagraph", section: a.section, block: a.block }]);
    } catch {
      return false; // 엔진의 정직한 거절(표/구조 문단/표 앵커) — 사용자 콘텐츠는 그대로다
    }
    await this.reanchor(a.section, a.block - 1, prevLen);
    return true;
  }

  /** 편집 후 문단 밴드를 다시 찾는다: 커밋으로 문단이 밀려 페이지를 옮겼을 수 있다(현재/다음/이전 순).
   *  `blocksInRect`가 있으면 그걸로(정확), 없으면 캐럿 자리 재-히트테스트로 근사. 못 찾으면 null. */
  private async reband(section: number, block: number, from: number, rect: CellCaretRect): Promise<{ page: number; band: BlockHit } | null> {
    const pages = this.session.pages || from + 1;
    const order = [from, from + 1, from - 1].filter((p) => p >= 0 && p < Math.max(pages, from + 1));
    for (const p of order) {
      if (this.adapter.blocksInRect) {
        const bands = await this.adapter.blocksInRect(p, 0, 0, 1e6, 1e6);
        const b = bands.find((h) => h.section === section && h.block === block && h.kind === "paragraph");
        if (b) return { page: p, band: b };
      }
      // blocksInRect가 없거나 아무것도 못 주면 캐럿 자리를 다시 찍어본다(같은 블록이면 채택).
      const h = await this.adapter.hitTest(p, rect.x + 1, rect.top + rect.height / 2);
      if (h && h.section === section && h.block === block && h.kind === "paragraph") return { page: p, band: h };
    }
    return null;
  }

  /** 읽기 → splice → `SetParagraphRuns` 커밋 → 재앵커의 공용 레인(insertText/deleteBack).
   *  범위가 살아 있으면 `del` 대신 **그 범위**를 지운다(타이핑 = 대체, Backspace = 범위 삭제). */
  private async splice(insert: string, del: number): Promise<boolean> {
    const a = this.state?.anchor;
    if (!a || !this.supported) return false;
    const runs = await this.adapter.blockRuns!(a.section, a.block);
    const text = runsText(runs);
    const { start, end } = selRange(a.selAnchor, a.offset);
    const ranged = end > start;
    const at = clampOffset(ranged ? end : a.offset, text.length);
    const delChars = ranged ? end - start : del;
    if (delChars > 0 && at === 0) return false; // 지울 게 앞에 없다(문단 병합은 mergeBack 이 맡는다)
    if (delChars === 0 && insert.length === 0) return false;
    const nextRuns = spliceRuns(runs, at, delChars, insert);
    await this.session.applyBatch([{ intent: "SetParagraphRuns", section: a.section, block: a.block, runs: nextRuns }]);
    // 편집은 이미 섰다. 이제 기하만 다시 잡는다 — 실패하면 캐럿만 사라진다(018).
    await this.reanchor(a.section, a.block, Math.max(0, at - delChars) + insert.length);
    return true;
  }
}
