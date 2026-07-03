/// hover.ts — the PURE logic + tiny store behind the issue-038 hover pre-highlight + cursor system
/// (FG-09 + FG-06). No DOM, no React here beyond the store's plain subscribe/emit, so the cursor policy
/// and the box/target math are unit-testable without a browser. The DOM wiring (pointermove → wasm query
/// → ref mutation) lives in `useHover`; the visual layer is `HoverLayer` (MarqueeLayer's twin).
///
/// Coordinate contract: every box here is own-render PAGE px (= HWPUNIT/75, §4.5) — the space the
/// adapter's hitTest/tableCellAt speak. `HoverLayer` multiplies by `scale` to reach client px.
import type { Box } from "@tf-hwp/editor-core";

/** The pre-highlight target under the cursor: a block/cell box in own-render PAGE px on `page`, tagged by
 *  `kind` (paragraph/cell/table/image/…). null ⇒ nothing under the cursor (highlight cleared). */
export interface HoverHighlight {
  page: number;
  box: Box;
  kind: string;
}

/** Whether two highlights are the SAME target (same page+kind and ~same box). Sub-px jitter is ignored so a
 *  re-query that resolves to the identical block does NOT churn the store (issue 038 §설계 dedup). */
export function sameHighlight(a: HoverHighlight | null, b: HoverHighlight | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.page === b.page &&
    a.kind === b.kind &&
    Math.abs(a.box.x - b.box.x) < 0.5 &&
    Math.abs(a.box.y - b.box.y) < 0.5 &&
    Math.abs(a.box.w - b.box.w) < 0.5 &&
    Math.abs(a.box.h - b.box.h) < 0.5
  );
}

/** Is the PAGE-px point (x,y) inside `box` (own-render px)? The cheap dedup pre-check: while the pointer
 *  stays inside the last hit's box it is over the SAME block, so the wasm re-query is skipped entirely. */
export function pointInBox(x: number, y: number, box: Box): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/// HoverStore — the single hover channel (issue 038, MarqueeLayer-style). `HoverLayer` subscribes to it
/// DIRECTLY so a hover move mutates only the tiny highlight layer via a ref, never the workspace/sheet.
/// `set` dedups identical targets so a re-query onto the same block emits nothing.
export class HoverStore {
  private cur: HoverHighlight | null = null;
  private listeners = new Set<(h: HoverHighlight | null) => void>();
  get(): HoverHighlight | null {
    return this.cur;
  }
  set(h: HoverHighlight | null): void {
    if (sameHighlight(this.cur, h)) return; // identical target → no emit (dedup)
    this.cur = h;
    for (const l of this.listeners) l(h);
  }
  subscribe(cb: (h: HoverHighlight | null) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

/** The cursor the pointer should show — the WHOLE policy of the FG-06 cursor system in one type. */
export type HoverCursor = "text" | "col-resize" | "row-resize" | "grab" | "grabbing" | "default";

/** Everything the cursor decision depends on (issue 038 §설계: hit kind → cursor, ONE pure function). */
export interface CursorContext {
  /** Space-hold pan DRAG in progress (035) → grabbing. */
  panning: boolean;
  /** Space-hold pan mode armed, no drag yet (035) → grab. */
  panMode: boolean;
  /** Over a 031 resize grip — reuse the existing grip DOM as the boundary judgment (no new arithmetic). */
  overGrip: "col" | "row" | null;
  /** The block kind under the pointer (paragraph → text I-beam), or null. */
  hitKind: string | null;
  /** editingOn — when false the doc isn't editable here, so no text/resize cursor: default only. */
  editing: boolean;
}

/// cursorForContext — the SINGLE mapping from context → cursor (issue 038 FG-06 "커서 매핑 한 곳"). Priority:
/// pan (035) wins (grabbing while dragging, grab while armed); then — only when editing — a 031 resize grip
/// → col/row-resize; then a text paragraph → text (I-beam); everything else is the default arrow. Pure +
/// total, so it is exhaustively unit-tested and the whole system's cursor policy lives in exactly one place.
export function cursorForContext(c: CursorContext): HoverCursor {
  if (c.panning) return "grabbing";
  if (c.panMode) return "grab";
  if (!c.editing) return "default";
  if (c.overGrip === "col") return "col-resize";
  if (c.overGrip === "row") return "row-resize";
  if (c.hitKind === "paragraph") return "text";
  return "default";
}

// ── dev-only instrumentation (issue 038) ─────────────────────────────────────────────────────────────
// Proof harness twin of issues 030/034: `DEV_INSTRUMENT` is a build-time constant (Vite folds
// `import.meta.env.PROD`) so every counter branch is dead-code-eliminated from a production bundle. Two
// signals: per-query wasm hit-test durations (step 1 "실측") and HoverLayer commit count (the ref-mutation
// discipline — a hover sweep across blocks on one page must not re-render even the tiny highlight layer).
const DEV_INSTRUMENT: boolean = (import.meta as { env?: { PROD?: boolean } }).env?.PROD !== true;
type HoverGlobal = { __hwHoverQueryMs?: number[]; __hwHoverLayerRenders?: number };

/** Record one hover hit-test duration (ms). */
export function recordHoverQueryMs(ms: number): void {
  if (!DEV_INSTRUMENT) return;
  const g = globalThis as HoverGlobal;
  (g.__hwHoverQueryMs ??= []).push(ms);
}
/** DEV/test helper: all recorded hover query durations since the last reset. */
export function __getHoverQueryMs(): number[] {
  return (globalThis as HoverGlobal).__hwHoverQueryMs ?? [];
}
/** DEV/test helper: zero the recorded hover query durations. */
export function __resetHoverQueryMs(): void {
  (globalThis as HoverGlobal).__hwHoverQueryMs = [];
}
/** Bump the HoverLayer commit counter (called at the top of each HoverLayer render). */
export function bumpHoverLayerRenderCount(): void {
  if (!DEV_INSTRUMENT) return;
  const g = globalThis as HoverGlobal;
  g.__hwHoverLayerRenders = (g.__hwHoverLayerRenders ?? 0) + 1;
}
/** DEV/test helper: how many times any HoverLayer has committed since the last reset. */
export function __getHoverLayerRenderCount(): number {
  return (globalThis as HoverGlobal).__hwHoverLayerRenders ?? 0;
}
/** DEV/test helper: zero the HoverLayer commit counter (call right before a measured hover). */
export function __resetHoverLayerRenderCount(): void {
  (globalThis as HoverGlobal).__hwHoverLayerRenders = 0;
}
