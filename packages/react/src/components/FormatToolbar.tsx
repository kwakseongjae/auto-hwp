import { useState } from "react";
import type { PageBox } from "../coords";
import { useWorkspaceMessages } from "../i18n";

export interface FormatToolbarProps {
  /** The selection box in own-render PAGE px (positions the floating toolbar above it). */
  box: PageBox;
  /** rendered px / viewBox px for the page (page px × scale = client px). */
  scale: number;
  /** The selection kind. The range/shade format ops are TABLE-CELL only (INTENT-SCHEMA §6.8), so for a
   *  paragraph/image selection the controls are DISABLED with a tooltip — never silently ignored
   *  (issue 027 step 5: "미지원은 비활성+툴팁 — 조용한 무시 금지"). */
  kind: "cell" | "range" | "paragraph" | "table" | "image" | string;
  /** OPTIONAL font family list for the 서체 picker (omit to hide it). */
  fonts?: readonly string[];
  /** Apply bold/italic (toggles). */
  onBold: () => void;
  onItalic: () => void;
  /** Apply an absolute font size in points. */
  onSize: (pt: number) => void;
  /** Apply a font family. */
  onFont: (family: string) => void;
  /** Apply a text color `#RRGGBB`. */
  onColor: (hex: string) => void;
  /** Apply / clear a background shade (`null` clears). */
  onShade: (hex: string | null) => void;
}

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32];

/// FormatToolbar — the opt-in floating format toolbar over a marked cell/range (issue 027 step 5): 굵게
/// / 기울임 / 글자 크기 / 서체 / 글자색 / 배경색. It maps to `SetCellRangeFmt` / `SetCellRangeShade`
/// (table-cell scoped), so on a non-cell selection every control is disabled with an explaining tooltip
/// rather than silently doing nothing. Individually importable; presentational; copy from the injectable
/// catalog (issue 077 — `messages.format`/`messages.formatToolbar`, Korean by default). The host wires the
/// callbacks to `core.edit.formatCellRange` / `shadeCellRange`.
export function FormatToolbar({ box, scale, kind, fonts, onBold, onItalic, onSize, onFont, onColor, onShade }: FormatToolbarProps) {
  const msg = useWorkspaceMessages();
  const cellScoped = kind === "cell" || kind === "range";
  const disabledTitle = cellScoped ? undefined : msg.formatToolbar.cellOnlyHint;
  const [size, setSize] = useState(11);

  const left = box.x * scale;
  const top = Math.max(0, box.y * scale - 44); // float ABOVE the selection

  return (
    <div
      className="hw-fmtbar"
      data-testid="hw-format-toolbar"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="hw-fmt-btn" disabled={!cellScoped} title={disabledTitle ?? msg.format.bold} data-testid="hw-fmt-bold" onClick={onBold}>
        <b>{msg.format.sampleGlyph}</b>
      </button>
      <button className="hw-fmt-btn" disabled={!cellScoped} title={disabledTitle ?? msg.format.italic} data-testid="hw-fmt-italic" onClick={onItalic}>
        <i>{msg.format.sampleGlyph}</i>
      </button>
      <select
        className="hw-fmt-size"
        disabled={!cellScoped}
        title={disabledTitle ?? msg.format.fontSize}
        data-testid="hw-fmt-size"
        value={size}
        onChange={(e) => {
          const pt = Number(e.target.value);
          setSize(pt);
          onSize(pt);
        }}
      >
        {SIZES.map((s) => (
          <option key={s} value={s}>
            {s}pt
          </option>
        ))}
      </select>
      {fonts && fonts.length > 0 && (
        <select
          className="hw-fmt-font"
          disabled={!cellScoped}
          title={disabledTitle ?? msg.format.fontFamily}
          data-testid="hw-fmt-font"
          defaultValue=""
          onChange={(e) => e.target.value && onFont(e.target.value)}
        >
          <option value="" disabled>
            {msg.format.fontFamily}
          </option>
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
      <label className="hw-fmt-color" title={disabledTitle ?? msg.format.textColor}>
        <span aria-hidden>{msg.format.textColor}</span>
        <input type="color" disabled={!cellScoped} data-testid="hw-fmt-color" defaultValue="#000000" onChange={(e) => onColor(e.target.value)} />
      </label>
      <label className="hw-fmt-color" title={disabledTitle ?? msg.format.backgroundColor}>
        <span aria-hidden>{msg.format.background}</span>
        <input type="color" disabled={!cellScoped} data-testid="hw-fmt-shade" defaultValue="#ffff00" onChange={(e) => onShade(e.target.value)} />
      </label>
      <button className="hw-fmt-btn" disabled={!cellScoped} title={disabledTitle ?? msg.format.clearBackground} data-testid="hw-fmt-shade-clear" onClick={() => onShade(null)}>
        {msg.format.clearBackground}
      </button>
    </div>
  );
}
