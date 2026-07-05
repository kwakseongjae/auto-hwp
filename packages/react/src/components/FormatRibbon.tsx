import { useEffect, useState } from "react";
import { saveInlineSelection } from "../richedit";
import type { ToolbarAlign } from "./FloatingToolbar";

/// FormatRibbon — the PERSISTENT top format bar (issue 048, ported from the desktop R11 `FormatControls`).
/// Unlike the 028 FloatingToolbar (which floats over the selection and hides while editing), this ribbon is
/// ALWAYS present in the editing chrome and is DUAL-MODE:
///   • 비편집 (a cell/range is marked): each control drives the SHARED `useSelectionActions` (039) — the
///     SAME `SetCellRangeFmt`/`SetCellRangeShade` op + toast as the FloatingToolbar (공용 유틸 하나).
///   • 편집 중 (the in-place editor is open): the host routes the SAME `onPatch` through
///     `richedit.applyLiveStyle`, styling the LIVE contentEditable selection (커밋 경로/latch 무접촉).
/// The host owns the routing; this component only renders the controls + fires `onPatch`.
///
/// 함정 (데스크톱이 이미 푼 문제): a ribbon button's mousedown must NOT collapse the contentEditable
/// selection. The B/I/U/S · 정렬 · 크기 ± · 배경 지움 buttons `preventDefault` their mousedown so the editor
/// keeps focus + the live selection (applyLiveStyle then sees `selInside` → styles in place). The native
/// controls that CANNOT preventDefault their focus (the 크기 input + the 색/배경 `<input type=color>`) instead
/// `saveInlineSelection()` on mousedown so applyLiveStyle can restore the editor selection before styling it.
/// The color inputs fire `onChange` ONLY — never `onInput` — so dragging the OS picker doesn't spam an op per
/// step (R13d 교훈).

/** The current character format at the selection/caret — drives the B/I/U/S toggles + the size/color display.
 *  `sizePt`/`color` mirror the marked cell's first run (비편집) or the caret's computed style (편집 중). */
export interface RibbonFmt {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  sizePt: number;
  color: string | null;
}

/** A format delta — exactly the changed attribute(s). The host routes it (편집 중 → applyLiveStyle, else →
 *  useSelectionActions). `shade`/`align` are cell-level ops (no live-run equivalent), so the ribbon only
 *  fires them when NOT editing; `underline`/`strike` are live-run styles, only fired while editing. */
export interface FormatRibbonPatch {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sizePt?: number;
  color?: string;
  shade?: string | null;
  align?: ToolbarAlign;
}

export interface FormatRibbonProps {
  /** The current format at the selection/caret (toggle + display state). */
  fmt: RibbonFmt;
  /** True while the in-place editor is OPEN (the host routes onPatch → applyLiveStyle). Drives which
   *  controls are enabled: 밑줄/취소선 need edit mode; 배경/정렬 are cell ops (비편집 only). */
  editing: boolean;
  /** Apply a format delta. HOST-routed: 편집 중 → richedit.applyLiveStyle; else → useSelectionActions. */
  onPatch: (patch: FormatRibbonPatch) => void;
  /** Reason the ALWAYS-controls (B/I/크기/글자색) are disabled — set when NOT editing AND no formattable
   *  cell/range is marked (미지원 조합은 조용한 무시 금지 — 비활성+사유, issue 027 rule). */
  inlineDisabledReason?: string;
  /** Reason the EDIT-ONLY controls (밑줄/취소선) are disabled — set when NOT editing (they have no
   *  SetCellRangeFmt equivalent — 신규 op 금지, so they apply only to the live selection). */
  liveOnlyDisabledReason?: string;
  /** Reason the CELL-OP-ONLY controls (배경/정렬) are disabled — set while editing (no live-run equivalent)
   *  OR when no formattable cell/range is marked. */
  cellOnlyDisabledReason?: string;
}

/// The persistent, position-free format ribbon. Presentational: it fires `onPatch` with the changed
/// attribute; the host resolves the dual routing. Toggle buttons light up from `fmt`.
export function FormatRibbon(props: FormatRibbonProps) {
  const { fmt, editing, onPatch, inlineDisabledReason, liveOnlyDisabledReason, cellOnlyDisabledReason } = props;

  const size = Math.round(fmt.sizePt);
  // The size box is directly EDITABLE (type + Enter/blur applies). Kept in a local string so partial typing
  // doesn't fight the controlled value; re-synced whenever the reflected size changes (caret move / reselect).
  const [sizeText, setSizeText] = useState(String(size));
  useEffect(() => setSizeText(String(size)), [size]);
  const commitSize = () => {
    const v = parseInt(sizeText, 10);
    if (Number.isFinite(v) && v >= 4 && v <= 96 && v !== size) onPatch({ sizePt: v });
    else setSizeText(String(size)); // invalid/empty → revert to the current size
  };

  const inlineOff = !!inlineDisabledReason;
  const liveOff = !!liveOnlyDisabledReason;
  const cellOff = !!cellOnlyDisabledReason;

  // Buttons that must NOT steal focus from the contentEditable (so the live selection survives the click).
  const keep = (e: React.MouseEvent) => e.preventDefault();
  // Native controls that CANNOT preventDefault their focus: snapshot the editor selection so applyLiveStyle
  // can restore it (harmless no-op when not editing — there is no [data-inline-edit] to read).
  const snapshot = (e: React.MouseEvent) => {
    e.stopPropagation();
    saveInlineSelection();
  };

  const btnClass = (active: boolean) => `hw-ribbon-btn${active ? " hw-ribbon-btn-active" : ""}`;

  return (
    <div className="hw-format-ribbon" data-testid="hw-format-ribbon" role="toolbar" aria-label="글자 서식">
      {/* 굵게 / 기울임 — both modes (SetCellRangeFmt bold/italic ↔ applyLiveStyle). */}
      <button
        type="button"
        className={btnClass(fmt.bold)}
        data-testid="hw-ribbon-bold"
        aria-pressed={fmt.bold}
        disabled={inlineOff}
        title={inlineDisabledReason ?? "굵게"}
        onMouseDown={keep}
        onClick={() => onPatch({ bold: !fmt.bold })}
      >
        <b>가</b>
      </button>
      <button
        type="button"
        className={btnClass(fmt.italic)}
        data-testid="hw-ribbon-italic"
        aria-pressed={fmt.italic}
        disabled={inlineOff}
        title={inlineDisabledReason ?? "기울임"}
        onMouseDown={keep}
        onClick={() => onPatch({ italic: !fmt.italic })}
      >
        <i>가</i>
      </button>
      {/* 밑줄 / 취소선 — EDIT-ONLY live styles (no SetCellRangeFmt field → disabled 비편집, with a reason). */}
      <button
        type="button"
        className={btnClass(fmt.underline)}
        data-testid="hw-ribbon-underline"
        aria-pressed={fmt.underline}
        disabled={liveOff}
        title={liveOnlyDisabledReason ?? "밑줄"}
        onMouseDown={keep}
        onClick={() => onPatch({ underline: !fmt.underline })}
      >
        <u>가</u>
      </button>
      <button
        type="button"
        className={btnClass(fmt.strike)}
        data-testid="hw-ribbon-strike"
        aria-pressed={fmt.strike}
        disabled={liveOff}
        title={liveOnlyDisabledReason ?? "취소선"}
        onMouseDown={keep}
        onClick={() => onPatch({ strike: !fmt.strike })}
      >
        <s>가</s>
      </button>

      <span className="hw-ribbon-sep" aria-hidden />

      {/* 글자 크기 스테퍼 — − / 직접입력 / + (both modes). */}
      <button
        type="button"
        className="hw-ribbon-btn"
        data-testid="hw-ribbon-size-dec"
        disabled={inlineOff}
        title={inlineDisabledReason ?? "작게"}
        onMouseDown={keep}
        onClick={() => onPatch({ sizePt: Math.max(4, size - 1) })}
      >
        −
      </button>
      <input
        className="hw-ribbon-size"
        data-testid="hw-ribbon-size"
        inputMode="numeric"
        disabled={inlineOff}
        title={inlineDisabledReason ?? "글자 크기(pt) — 입력 후 Enter"}
        value={sizeText}
        onMouseDown={snapshot}
        onChange={(e) => setSizeText(e.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 2))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitSize();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={commitSize}
      />
      <button
        type="button"
        className="hw-ribbon-btn"
        data-testid="hw-ribbon-size-inc"
        disabled={inlineOff}
        title={inlineDisabledReason ?? "크게"}
        onMouseDown={keep}
        onClick={() => onPatch({ sizePt: Math.min(96, size + 1) })}
      >
        +
      </button>

      <span className="hw-ribbon-sep" aria-hidden />

      {/* 글자색 — 연속 스펙트럼(OS 색상 선택기). onChange ONLY (no onInput → no per-step op spam, R13d). */}
      <label className="hw-ribbon-color" data-testid="hw-ribbon-color-label" title={inlineDisabledReason ?? "글자색"} onMouseDown={snapshot}>
        <span aria-hidden>글자색</span>
        <input
          type="color"
          data-testid="hw-ribbon-color"
          disabled={inlineOff}
          value={fmt.color ?? "#000000"}
          onChange={(e) => onPatch({ color: e.target.value })}
        />
      </label>

      {/* 배경색 — CELL op (SetCellRangeShade); no live-run equivalent → disabled 편집 중, with a reason. */}
      <label className="hw-ribbon-color" data-testid="hw-ribbon-shade-label" title={cellOnlyDisabledReason ?? "배경색"} onMouseDown={snapshot}>
        <span aria-hidden>배경</span>
        <input
          type="color"
          data-testid="hw-ribbon-shade"
          disabled={cellOff}
          defaultValue="#ffff00"
          onChange={(e) => onPatch({ shade: e.target.value })}
        />
      </label>
      <button
        type="button"
        className="hw-ribbon-btn"
        data-testid="hw-ribbon-shade-clear"
        disabled={cellOff}
        title={cellOnlyDisabledReason ?? "배경 지움"}
        onMouseDown={keep}
        onClick={() => onPatch({ shade: null })}
      >
        배경 지움
      </button>

      <span className="hw-ribbon-sep" aria-hidden />

      {/* 정렬 — CELL op (SetCellRangeFmt align); disabled 편집 중 (align a whole cell, not a live run). */}
      <button type="button" className="hw-ribbon-btn" data-testid="hw-ribbon-align-left" disabled={cellOff} title={cellOnlyDisabledReason ?? "왼쪽 정렬"} onMouseDown={keep} onClick={() => onPatch({ align: "left" })}>
        ≤
      </button>
      <button type="button" className="hw-ribbon-btn" data-testid="hw-ribbon-align-center" disabled={cellOff} title={cellOnlyDisabledReason ?? "가운데 정렬"} onMouseDown={keep} onClick={() => onPatch({ align: "center" })}>
        ≡
      </button>
      <button type="button" className="hw-ribbon-btn" data-testid="hw-ribbon-align-right" disabled={cellOff} title={cellOnlyDisabledReason ?? "오른쪽 정렬"} onMouseDown={keep} onClick={() => onPatch({ align: "right" })}>
        ≥
      </button>
      <button type="button" className="hw-ribbon-btn" data-testid="hw-ribbon-align-justify" disabled={cellOff} title={cellOnlyDisabledReason ?? "양쪽 정렬"} onMouseDown={keep} onClick={() => onPatch({ align: "justify" })}>
        ☰
      </button>

      {/* Mode hint — 편집 중이면 라이브 선택, 아니면 선택 셀/범위. */}
      <span className="hw-ribbon-mode" data-testid="hw-ribbon-mode">
        {editing ? "✏️ 편집 중 · 선택한 글자에 적용" : "✦ 선택한 칸/범위에 적용"}
      </span>
    </div>
  );
}
