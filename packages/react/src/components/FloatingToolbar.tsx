import { useLayoutEffect, useRef, useState } from "react";
import type { PageBox } from "../coords";
import { computeFloatingPosition } from "../floatingPosition";
import { useWorkspaceMessages } from "../i18n";

/** Text alignment the toolbar can apply — maps straight onto `SetCellRangeFmt.align` (INTENT-SCHEMA §6.8,
 *  via editor-core `formatCellRange`). No new op is introduced (issue 028: surface redesign only). */
export type ToolbarAlign = "left" | "center" | "right" | "justify";

export interface FloatingToolbarProps {
  /** The selection MARK boxes on THIS page (own-render PAGE px). Multi-selection → union bbox anchors it. */
  marks: readonly PageBox[];
  /** rendered px / viewBox px for the page (the SINGLE conversion from HwpPageView — never re-derived). */
  scale: number;
  /** The positioning container's client-px width (the page sheet width) for the horizontal clamp. */
  viewportWidth: number;
  /** The selection kind, only used for the mark-scope label/tooltips. */
  kind: string;
  /** When set, the FORMAT controls are disabled and show this reason as their tooltip (issue 027 rule:
   *  미지원 조합은 조용한 무시 금지 — 비활성+사유). `undefined` → format controls are enabled. */
  formatDisabledReason?: string;
  /** Optional 서체 catalog (family names). Each option previews in its own family (best-effort). */
  fonts?: readonly string[];
  /** Whether the "AI에게 전달" entry is available (a document is open + editable). */
  aiEnabled: boolean;
  onBold: () => void;
  onItalic: () => void;
  onSize: (pt: number) => void;
  onFont: (family: string) => void;
  onColor: (hex: string) => void;
  onShade: (hex: string | null) => void;
  onAlign: (align: ToolbarAlign) => void;
  /** Confirm the current selection as an anchor chip + focus the chat composer (issue 028 — the vibe-edit
   *  entry point). Reuses the existing chip/focus path; NO new prompt logic. */
  onSendToAi: () => void;
}

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32];
// Initial estimate before the capsule measures itself (so the first paint is close; it snaps after mount).
const EST_W = 360;
const EST_H = 38;

/// FloatingToolbar — the capsule selection toolbar (issue 028, 네이버 블로그 에디터 패턴). It floats just
/// above the selection with a tail pointing at it, flips below near the viewport top, and clamps to the
/// sides — all via the pure `computeFloatingPosition`. It measures its own size and re-feeds it so the
/// centering/clamping is exact under zoom. Controls: 서체 · 크기(프리셋+직접입력) · B · I · 글자색 · 배경 ·
/// 정렬 · ✨AI에게 전달. FORMAT controls drive editor-core's `formatCellRange`/`shadeCellRange` (027 core —
/// no new op); on an unsupported selection they are DISABLED with a Korean reason tooltip (never silent).
/// "AI에게 전달" reuses the anchor-chip + chat-focus path. Presentational + individually importable.
export function FloatingToolbar(props: FloatingToolbarProps) {
  const msg = useWorkspaceMessages();
  const {
    marks,
    scale,
    viewportWidth,
    formatDisabledReason,
    fonts,
    aiEnabled,
    onBold,
    onItalic,
    onSize,
    onFont,
    onColor,
    onShade,
    onAlign,
    onSendToAi,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: EST_W, h: EST_H });
  const [size, setSize] = useState<string>("11");

  // Measure the capsule after each render; feed the real size back so the position (center/clamp/flip) is
  // exact. Guarded by an inequality so it converges (measure → setState → re-measure equal → stop).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (Math.abs(r.width - dims.w) > 0.5 || Math.abs(r.height - dims.h) > 0.5)) {
      setDims({ w: r.width, h: r.height });
    }
  });

  const pos = computeFloatingPosition(marks, scale, { width: viewportWidth }, { toolbarWidth: dims.w, toolbarHeight: dims.h });
  if (!pos) return null;

  const fmtDisabled = !!formatDisabledReason;
  const fmtTitle = (label: string) => formatDisabledReason ?? label;

  const commitSize = (raw: string) => {
    const pt = Number(raw);
    if (Number.isFinite(pt) && pt >= 4 && pt <= 96) onSize(pt);
  };

  return (
    <div
      ref={ref}
      className="hw-floatbar"
      data-testid="hw-floating-toolbar"
      data-placement={pos.placement}
      style={{ left: pos.x, top: pos.y }}
      // The toolbar is an "inside" region: swallow pointerdown so it never reads as an outside/deselect
      // click (issue 028 §함정).
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 서체 */}
      {fonts && fonts.length > 0 && (
        <select
          className="hw-floatbar-font"
          data-testid="hw-fmt-font"
          disabled={fmtDisabled}
          title={fmtTitle(msg.format.fontFamily)}
          defaultValue=""
          onChange={(e) => e.target.value && onFont(e.target.value)}
        >
          <option value="" disabled>
            {msg.format.fontFamily}
          </option>
          {fonts.map((f) => (
            <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
              {f}
            </option>
          ))}
        </select>
      )}

      {/* 크기 — 프리셋(datalist) + 직접입력 */}
      <input
        className="hw-floatbar-size"
        data-testid="hw-fmt-size"
        type="number"
        min={4}
        max={96}
        list="hw-fmt-size-presets"
        disabled={fmtDisabled}
        title={fmtTitle(msg.format.fontSize)}
        value={size}
        // onChange keeps the field controlled; the size is COMMITTED on Enter/blur so a partial number
        // never spams an Intent per keystroke.
        onChange={(e) => setSize(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitSize(e.currentTarget.value);
          }
        }}
        onBlur={(e) => commitSize(e.currentTarget.value)}
      />
      <datalist id="hw-fmt-size-presets">
        {SIZES.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      <span className="hw-floatbar-sep" aria-hidden />

      {/* B / I */}
      <button className="hw-floatbar-btn" data-testid="hw-fmt-bold" disabled={fmtDisabled} title={fmtTitle(msg.format.bold)} onClick={onBold}>
        <b>{msg.format.sampleGlyph}</b>
      </button>
      <button className="hw-floatbar-btn" data-testid="hw-fmt-italic" disabled={fmtDisabled} title={fmtTitle(msg.format.italic)} onClick={onItalic}>
        <i>{msg.format.sampleGlyph}</i>
      </button>

      <span className="hw-floatbar-sep" aria-hidden />

      {/* 글자색 / 배경 / 배경 지움 */}
      <label className="hw-floatbar-color" title={fmtTitle(msg.format.textColor)}>
        <span aria-hidden>{msg.format.textColor}</span>
        <input type="color" data-testid="hw-fmt-color" disabled={fmtDisabled} defaultValue="#000000" onChange={(e) => onColor(e.target.value)} />
      </label>
      <label className="hw-floatbar-color" title={fmtTitle(msg.format.backgroundColor)}>
        <span aria-hidden>{msg.format.background}</span>
        <input type="color" data-testid="hw-fmt-shade" disabled={fmtDisabled} defaultValue="#ffff00" onChange={(e) => onShade(e.target.value)} />
      </label>
      <button className="hw-floatbar-btn" data-testid="hw-fmt-shade-clear" disabled={fmtDisabled} title={fmtTitle(msg.format.clearBackground)} onClick={() => onShade(null)}>
        {msg.format.clearBackground}
      </button>

      <span className="hw-floatbar-sep" aria-hidden />

      {/* 정렬 */}
      <button className="hw-floatbar-btn" data-testid="hw-fmt-align-left" disabled={fmtDisabled} title={fmtTitle(msg.format.alignLeft)} onClick={() => onAlign("left")}>
        ≤
      </button>
      <button className="hw-floatbar-btn" data-testid="hw-fmt-align-center" disabled={fmtDisabled} title={fmtTitle(msg.format.alignCenter)} onClick={() => onAlign("center")}>
        ≡
      </button>
      <button className="hw-floatbar-btn" data-testid="hw-fmt-align-right" disabled={fmtDisabled} title={fmtTitle(msg.format.alignRight)} onClick={() => onAlign("right")}>
        ≥
      </button>
      <button className="hw-floatbar-btn" data-testid="hw-fmt-align-justify" disabled={fmtDisabled} title={fmtTitle(msg.format.alignJustify)} onClick={() => onAlign("justify")}>
        ☰
      </button>

      <span className="hw-floatbar-sep" aria-hidden />

      {/* ✨ AI에게 전달 — 이 툴바의 차별점(바이브편집 진입점). 서식과 무관하게 선택이 있으면 활성. */}
      <button
        className="hw-floatbar-ai"
        data-testid="hw-fmt-ai"
        disabled={!aiEnabled}
        title={aiEnabled ? msg.floatingToolbar.aiSendTitle : msg.floatingToolbar.aiDisabledTitle}
        onClick={onSendToAi}
      >
        {msg.floatingToolbar.aiSend}
      </button>

      {/* 아래/위 꼬리 — 선택 영역을 가리킨다 */}
      <span className="hw-floatbar-tail" data-testid="hw-floating-tail" style={{ left: pos.caretLeft }} aria-hidden />
    </div>
  );
}
