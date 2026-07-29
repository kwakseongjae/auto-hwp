import { useEffect, useState } from "react";
import type { WorkspaceDesignSelection } from "./HwpWorkspace";
import type { FormatRibbonPatch } from "./FormatRibbon";

export interface DesignPanelProps {
  selection: WorkspaceDesignSelection | null;
  fonts?: readonly string[];
  onPatch: (patch: FormatRibbonPatch) => void;
  textEditing?: boolean;
}

const KIND_LABEL: Record<WorkspaceDesignSelection["kind"], string> = {
  paragraph: "텍스트",
  cell: "표 셀",
  range: "셀 범위",
  table: "표",
  image: "이미지",
  other: "요소",
};

function n(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

/** Reference Figma-style inspector. Controls apply immediately to the selected engine address; the page
 *  itself stays visually clean and owns only selection/caret overlays. */
export function DesignPanel({ selection, fonts, onPatch, textEditing = false }: DesignPanelProps) {
  const reflectedSize = Math.round(selection?.format.sizePt ?? 10);
  const [size, setSize] = useState(String(reflectedSize));
  useEffect(() => setSize(String(reflectedSize)), [reflectedSize, selection?.section, selection?.block]);

  if (!selection) {
    return (
      <section className="hw-design hw-design-empty" data-testid="hw-design-panel">
        <div className="hw-design-empty-icon" aria-hidden>◇</div>
        <strong>선택한 요소가 없습니다</strong>
        <p>문단이나 표 셀을 클릭하면 위치와 글자 디자인을 확인하고 수정할 수 있습니다.</p>
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
          <span className="hw-design-kind">{KIND_LABEL[selection.kind]}</span>
          <strong title={selection.label}>{selection.label}</strong>
        </div>
        <span className="hw-design-page">p.{selection.page + 1}</span>
      </div>

      {textEditing && (
        <div className="hw-design-editing-note" role="status">
          <span className="hw-design-editing-dot" aria-hidden />
          <div><strong>텍스트 편집 중</strong><span>캔버스의 글자와 커서에 집중하세요.</span></div>
        </div>
      )}

      {!textEditing && (
        <div className="hw-design-section">
          <h3>프레임</h3>
          <div className="hw-design-grid hw-design-geometry">
            <label><span>X</span><output>{n(selection.box.x)}</output></label>
            <label><span>Y</span><output>{n(selection.box.y)}</output></label>
            <label><span>W</span><output>{n(selection.box.w)}</output></label>
            <label><span>H</span><output>{n(selection.box.h)}</output></label>
          </div>
        </div>
      )}

      <div className="hw-design-section">
        <h3>텍스트</h3>
        <select
          className="hw-design-select"
          data-testid="hw-design-font"
          disabled={!selection.canTextStyle || fontChoices.length === 0}
          value={selection.format.font ?? ""}
          onChange={(e) => {
            if (e.currentTarget.value) onPatch({ font: e.currentTarget.value });
          }}
          aria-label="서체"
        >
          <option value="">{selection.format.font ?? "서체 선택"}</option>
          {fontChoices.map((font) => (
            <option key={font} value={font} style={{ fontFamily: `"${font}"` }}>
              {font}
            </option>
          ))}
        </select>

        <div className="hw-design-row">
          <div className="hw-design-stepper">
            <button type="button" disabled={!selection.canTextStyle} onClick={() => onPatch({ sizePt: Math.max(4, reflectedSize - 1) })} aria-label="글자 작게">−</button>
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
              aria-label="글자 크기"
            />
            <button type="button" disabled={!selection.canTextStyle} onClick={() => onPatch({ sizePt: Math.min(96, reflectedSize + 1) })} aria-label="글자 크게">+</button>
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
          <label className="hw-design-color" title="글자색">
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
        <h3>셀</h3>
        <div className="hw-design-row">
          <label className="hw-design-fill">
            <span>배경</span>
            <input
              type="color"
              data-testid="hw-design-shade"
              disabled={!selection.canCellStyle}
              defaultValue="#ffffff"
              onChange={(e) => onPatch({ shade: e.currentTarget.value })}
            />
          </label>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ shade: null })}>지우기</button>
        </div>
        <div className="hw-design-align" role="group" aria-label="정렬">
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "left" })} title="왼쪽 정렬">≡</button>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "center" })} title="가운데 정렬">≡</button>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "right" })} title="오른쪽 정렬">≡</button>
          <button type="button" disabled={!selection.canCellStyle} onClick={() => onPatch({ align: "justify" })} title="양쪽 정렬">☰</button>
        </div>
        {!selection.canCellStyle && <p className="hw-design-note">배경과 셀 정렬은 표 셀 또는 셀 범위를 선택하면 사용할 수 있습니다.</p>}
      </div>}
    </section>
  );
}
