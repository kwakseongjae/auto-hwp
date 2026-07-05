import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition, type MenuViewport } from "../contextMenuPosition";

export interface ColumnWidthDialogProps {
  /** Desired anchor (client px — where the menu item / toolbar button was clicked). Clamped to viewport. */
  x: number;
  y: number;
  /** The TARGET column's current width in millimetres, MEASURED from the live boundaries (issue 047 §함정
   *  거짓 정밀도 금지 / 적용-확인: the host recomputes this from the re-queried boundaries after every apply,
   *  so the readout always reflects the ACTUAL geometry — never a value the engine didn't land on). */
  currentMm: number;
  /** The target column's human label for the heading (e.g. "3열"). */
  columnLabel: string;
  /** How many columns 균등 분배 will affect (for the button label + enablement). < 2 → the equalize button
   *  is disabled with a reason (equalizing a single column is a no-op). */
  equalizeCount: number;
  /** Apply a precise mm width to the target column (the host converts mm→px→ratios via units.ts + commits
   *  with apply-verify). */
  onApplyMm: (mm: number) => void;
  /** 균등 분배: equalize the affected columns to one width (host math in units.ts). */
  onEqualize: () => void;
  /** Close the dialog (Esc / outside click / scroll / after applying). */
  onClose: () => void;
  /** Positioning viewport (default = the window). */
  viewport?: MenuViewport;
}

const EST_W = 220;
const EST_H = 150;
const MIN_MM = 2;

/// ColumnWidthDialog — the issue-047 소형 다이얼로그 for PRECISE column width (mm) + 균등 분배 (열 너비 균등
/// 분배). It shows the target column's CURRENT width in mm (실측값 — measured from the live boundaries by the
/// host so it reflects the real geometry after every apply), takes an mm value, and offers a one-click equal
/// distribution. It owns ONLY surface concerns (viewport-edge clamp, Esc / outside-click / scroll close) and
/// NO edit math: the mm→px→ratio conversion + apply-verify live in the host (editor-core units.ts, single
/// conversion point). Presentational + individually importable — a host can mount it over the core without
/// HwpWorkspace. Mirrors the desktop R13-5 "크기 ▾ → 열 너비 mm / 균등 분배" menu.
export function ColumnWidthDialog({ x, y, currentMm, columnLabel, equalizeCount, onApplyMm, onEqualize, onClose, viewport }: ColumnWidthDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: EST_W, h: EST_H });

  // Measure the dialog after render; re-feed the real size so the clamp is exact (converges via the guard).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (Math.abs(r.width - size.w) > 0.5 || Math.abs(r.height - size.h) > 0.5)) {
      setSize({ w: r.width, h: r.height });
    }
  });

  // Focus + select the mm field on open so the user can type a value immediately.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Close on outside pointerdown, any scroll, and a window resize (same discipline as ContextMenu). Capture
  // phase so a scroll on the inner canvas (which doesn't bubble to window) still closes it.
  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
    };
  }, [onClose]);

  const commitMm = (raw: string) => {
    const mm = parseFloat(raw);
    if (Number.isFinite(mm) && mm >= MIN_MM) onApplyMm(mm);
  };

  const vp = viewport ?? { width: typeof window !== "undefined" ? window.innerWidth : 1024, height: typeof window !== "undefined" ? window.innerHeight : 768 };
  const pos = clampMenuPosition(x, y, size.w, size.h, vp);
  const canEqualize = equalizeCount >= 2;

  return (
    <div
      ref={ref}
      className="hw-colwidth"
      data-testid="hw-colwidth-dialog"
      role="dialog"
      aria-label="열 너비"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="hw-colwidth-head">열 너비 · {columnLabel}</div>
      <label className="hw-colwidth-row">
        <span className="hw-colwidth-label">너비</span>
        <input
          // Key on the measured width so an APPLY (which re-measures the real boundaries → a new `currentMm`)
          // REMOUNTS the field showing the ACTUAL applied value — the visible 적용-확인 / 왕복 오차 반영.
          key={currentMm.toFixed(1)}
          ref={inputRef}
          className="hw-colwidth-input"
          data-testid="hw-colwidth-input"
          type="number"
          min={MIN_MM}
          step={0.5}
          defaultValue={currentMm.toFixed(1)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitMm(e.currentTarget.value);
            }
          }}
        />
        <span className="hw-colwidth-unit">mm</span>
      </label>
      <div className="hw-colwidth-actions">
        <button
          type="button"
          className="hw-colwidth-apply"
          data-testid="hw-colwidth-apply"
          onClick={() => {
            if (inputRef.current) commitMm(inputRef.current.value);
          }}
        >
          적용
        </button>
        <button
          type="button"
          className="hw-colwidth-equalize"
          data-testid="hw-colwidth-equalize"
          disabled={!canEqualize}
          title={canEqualize ? undefined : "여러 열을 선택하면 균등 분배할 수 있습니다"}
          onClick={onEqualize}
        >
          균등 분배 ({equalizeCount}열)
        </button>
      </div>
      <p className="hw-colwidth-note">현재 {currentMm.toFixed(1)}mm · 적용 후 실제 경계를 다시 측정해 반영합니다.</p>
    </div>
  );
}
