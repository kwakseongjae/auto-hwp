import type { EngineAdapter } from "./adapter";
import type { CellAddr, CellCaretRect } from "./types";

/** #507 — model addresses, independent of page, zoom and mounted SVGs. */
export interface FocusParagraphAddress {
  section: number;
  block: number;
}

export interface FocusCellAddress extends FocusParagraphAddress {
  row: number;
  col: number;
  /** Full descent from the outer table to the leaf; row/col must match that leaf. */
  path?: CellAddr[];
  /** Editor-space (newline-separated) paragraph in the cell, default 0. */
  para?: number;
}

export type FocusTarget =
  | ({ kind: "cell" } & FocusCellAddress)
  | ({ kind: "paragraph" } & FocusParagraphAddress);
export type FocusOffset = number | "end";
/** A shell may prepare a virtualized page before the caret is published. False preserves the old caret. */
export type PrepareFocus = (rect: CellCaretRect) => Promise<boolean>;

export function validFocusAddress(addr: FocusParagraphAddress): boolean {
  return [addr.section, addr.block].every((n) => Number.isSafeInteger(n) && n >= 0);
}

export function validFocusCell(addr: FocusCellAddress): boolean {
  if (!validFocusAddress(addr) || ![addr.row, addr.col, addr.para ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  if (!addr.path?.length) return true;
  if (!addr.path.every((p) => [p.block, p.row, p.col].every((n) => Number.isSafeInteger(n) && n >= 0))) return false;
  const leaf = addr.path[addr.path.length - 1];
  return addr.path[0].block === addr.block && leaf.row === addr.row && leaf.col === addr.col;
}

function cellKey(target: FocusCellAddress): string {
  const path = target.path?.length ? target.path : [{ block: target.block, row: target.row, col: target.col }];
  return JSON.stringify([target.section, ...path.flatMap((p) => [p.block, p.row, p.col])]);
}

function orderKey(target: FocusTarget, paragraphBlocks?: ReadonlyMap<string, readonly number[]>): number[] {
  if (target.kind === "paragraph") return [target.section, target.block];
  const path = target.path?.length ? target.path : [{ block: target.block, row: target.row, col: target.col }];
  // The original block ordinal places each paragraph before/after nested tables in its containing
  // cell. Older adapters lack that metadata: their containing text precedes descendant tables.
  const para = target.para ?? 0;
  return [target.section, ...path.flatMap((p) => [p.block, p.row, p.col]), paragraphBlocks?.get(cellKey(target))?.[para] ?? -1, -1, para];
}

/** Section → block → row/column → cell paragraphs / descending table path. */
export function compareFocusTargets(a: FocusTarget, b: FocusTarget, paragraphBlocks?: ReadonlyMap<string, readonly number[]>): number {
  const ak = orderKey(a, paragraphBlocks);
  const bk = orderKey(b, paragraphBlocks);
  for (let i = 0; i < Math.min(ak.length, bk.length); i++) {
    if (ak[i] !== bk[i]) return ak[i] - bk[i];
  }
  return ak.length - bk.length;
}

/** Enumerate placed addresses, deduplicating split/merged cells and repeated paragraph bands. Policy
 *  and caret geometry are checked when entering each candidate, so a failed candidate can be skipped. */
export interface FocusOrder {
  targets: FocusTarget[];
  compare(a: FocusTarget, b: FocusTarget): number;
}

export async function collectFocusTargets(adapter: EngineAdapter, pages: number): Promise<FocusOrder> {
  const targets = new Map<string, FocusTarget>();
  const paragraphBlocks = new Map<string, readonly number[]>();
  const add = (target: FocusTarget) => targets.set(JSON.stringify(orderKey(target)), target);
  for (let page = 0; page < pages; page++) {
    const [cells, bands] = await Promise.all([
      adapter.cellBoxes?.(page) ?? [],
      adapter.blocksInRect?.(page, 0, 0, 1e6, 1e6) ?? [],
    ]);
    for (const c of cells) {
      if (!(c.w > 0 && c.h > 0)) continue;
      const path = c.path.length > 1 ? c.path : undefined;
      const addr = { section: c.section, block: c.block, row: c.row, col: c.col, ...(path ? { path } : {}) };
      if (!validFocusCell(addr)) continue;
      if (c.paragraph_blocks) paragraphBlocks.set(cellKey(addr), c.paragraph_blocks);
      const paras = c.paragraph_blocks ?? c.text.split("\n");
      paras.forEach((_text, para) => add({ kind: "cell", ...addr, para }));
    }
    for (const b of bands) {
      if (b.kind === "paragraph" && b.editable && b.h > 1 && validFocusAddress(b)) {
        add({ kind: "paragraph", section: b.section, block: b.block });
      }
    }
  }
  const compare = (a: FocusTarget, b: FocusTarget) => compareFocusTargets(a, b, paragraphBlocks);
  return { targets: [...targets.values()].sort(compare), compare };
}
