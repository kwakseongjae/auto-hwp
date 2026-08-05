import { useEffect, useState } from "react";
import type { WorkspaceDesignSelection } from "./HwpWorkspace";
import type { FormatRibbonPatch } from "./FormatRibbon";
import { useWorkspaceMessages } from "../i18n";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, MousePointerClick } from "../icons";

export interface DesignPanelProps {
  selection: WorkspaceDesignSelection | null;
  fonts?: readonly string[];
  onPatch: (patch: FormatRibbonPatch) => void;
  textEditing?: boolean;
}

function n(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

/** Reference Figma-style inspector. Controls apply immediately to the selected engine address; the page
 *  itself stays visually clean and owns only selection/caret overlays. */
export function DesignPanel({ selection, fonts, onPatch, textEditing = false }: DesignPanelProps) {
  const msg = useWorkspaceMessages();
  const reflectedSize = Math.round(selection?.format.sizePt ?? 10);
  const [size, setSize] = useState(String(reflectedSize));
  useEffect(() => setSize(String(reflectedSize)), [reflectedSize, selection?.section, selection?.block]);

  if (!selection) {
    return (
      <section className="hw-design hw-design-empty" data-testid="hw-design-panel">
        <div className="hw-design-empty-icon" aria-hidden><MousePointerClick size={22} /></div>
        <strong>{msg.design.emptyTitle}</strong>
        <p>{msg.design.emptyHint}</p>
      </section>
    );
  }

  const commitSize = () => {
    const value = Number.parseInt(size, 10);
    if (selection.canTextStyle && Number.isFinite(value) && value >= 4 && value <= 96) {
      onPatch({ sizePt: value });
    } else {
      setSize(String(reflectedSize));
    }
  };
  const fontChoices = fonts
    ? selection.format.font && !fonts.includes(selection.format.font)
      ? [selection.format.font, ...fonts]
      : fonts
    : selection.format.font
      ? [selection.format.font]
      : [];

  return (
    <section className={`hw-design${textEditing ? " is-text-editing" : ""}`} data-testid="hw-design-panel">
      <div className="hw-design-selection">
        <div>
          <span className="hw-design-kind">{msg.design.kind[selection.kind]}</span>
          <strong title={selection.label}>{selection.label}</strong>
        </div>
        <span className="hw-design-page">p.{selection.page + 1}</span>
      </div>

      {textEditing && (
        <div className="hw-design-editing-note" role="status">
          <span className="hw-design-editing-dot" aria-hidden />
          <div><strong>{msg.design.editingTitle}</strong><span>{msg.design.editingHint}</span></div>
        </div>
      )}

      {!textEditing && (
        <div className="hw-design-section">
          <h3>{msg.design.frameSection}</h3>
          <div className="hw-design-grid hw-design-geometry">
            <label><span>X</span><output>{n(selection.box.x)}</output></label>
            <label><span>Y</span><output>{n(selection.box.y)}</output></label>
            <label><span>W</span><output>{n(selection.box.w)}</output></label>
            <label><span>H</span><output>{n(selection.box.h)}</output></label>
          </div>
        </div>
      )}

      <div className="hw-design-section">
        <h3>{msg.design.textSection}</h3>
        <select
          className="hw-design-select"
          data-testid="hw-design-font"
          disabled={!selection.canTextStyle || fontChoices.length === 0}
          value={selection.format.font ?? ""}
          onChange={(e) => {
            if (e.currentTarget.value) onPatch({ font: e.currentTarget.value });
          }}
          aria-label={msg.format.fontFamily}
        >
          <option value="">{selection.format.font ?? msg.format.fontFamilyPlaceholder}</option>
          {fontChoices.map((font) => (
            <option key={font} value={font} style={{ fontFamily: `"${font}"` }}>
              {font}
            </option>
          ))}
        </select>

        <div className="hw-design-row">
          <div className="hw-design-stepper">
            <button type="button" disabled={!selection.canTextStyle} onClick={() => onPatch({ sizePt: Math.max(4, reflectedSize - 1) })} aria-label={msg.format.decreaseFontSize}>−</button>
            <input
              data-testid="hw-design-size"
              disabled={!selection.canTextStyle}
              inputMode="numeric"
              value={size}
              onChange={(e) => setSize(e.currentTarget.value.replace(/\D/g, "").slice(0, 2))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitSize();
                  e.currentTarget.blur();
                }
              }}
              onBlur={commitSize}
              aria-label={msg.format.fontSize}
            />
            <button type="button" disabled={!selection.canTextStyle} onClick={() => onPatch({ sizePt: Math.min(96, reflectedSize + 1) })} aria-label={msg.format.increaseFontSize}>+</button>
          </div>
          <button
            type="button"
            className={`hw-design-toggle${selection.format.bold ? " is-active" : ""}`}
            data-testid="hw-design-bold"
            aria-pressed={selection.format.bold}
            disabled={!selection.canTextStyle}
            onClick={() => onPatch({ bold: !selection.format.bold })}
          >
            B
          </button>
          <button
            type="button"
            className={`hw-design-toggle${selection.format.italic ? " is-active" : ""}`}
            data-testid="hw-design-italic"
            aria-pressed={selection.format.italic}
            disabled={!selection.canTextStyle}
            onClick={() => onPatch({ italic: !selection.format.italic })}
          >
            <i>I</i>
          </button>
          <label className="hw-design-color" title={msg.format.textColor}>
            <input
              type="color"
              data-testid="hw-design-color"
              disabled={!selection.canTextStyle}
              value={selection.format.color ?? "#000000"}
              onChange={(e) => onPatch({ color: e.currentTarget.value })}
            />
          </label>
        </div>
      </div>

      {!textEditing && <div className="hw-design-section">
        <h3>{msg.design.cellSection}</h3>
        <div className="hw-design-row">
          <label className="hw-design-fill">
            <span>{msg.format.background}</span>
            <input
              type="color"
              data-testid="hw-design-shade"
              disabled={!selection.canCellStyle}
              defaultValue="#ffffff"
              onChange={(e) => onPatch({ shade: e.currentTarget.value })}
            />
          </label>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ shade: null })}>{msg.design.clear}</button>
        </div>
        <div className="hw-design-align" role="group" aria-label={msg.format.align}>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "left" })} title={msg.format.alignLeft} aria-label={msg.format.alignLeft}><AlignLeft /></button>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "center" })} title={msg.format.alignCenter} aria-label={msg.format.alignCenter}><AlignCenter /></button>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "right" })} title={msg.format.alignRight} aria-label={msg.format.alignRight}><AlignRight /></button>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "justify" })} title={msg.format.alignJustify} aria-label={msg.format.alignJustify}><AlignJustify /></button>
        </div>
        {!selection.canCellStyle && <p className="hw-design-note">{msg.design.cellOnlyNote}</p>}
      </div>}
    </section>
  );
}
