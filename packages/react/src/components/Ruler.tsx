import { useCallback, useEffect, useState } from "react";
import { mmToPx, pxToMm, roundMm, type PageGeom, type PageMarginsMm } from "@auto-hwp/editor-core";

export interface RulerProps {
  /** Page geometry in own-render PAGE px (from `core.session.pageGeom`). */
  geom: PageGeom;
  /** rendered px / viewBox px for the page it sits over (page px × scale = client px). */
  scale: number;
  /** OPTIONAL — fired on a margin-handle release with the FULL new margins (mm). ⚠️ document-wide: the
   *  host MUST confirm before applying `SetPageMargins` (it re-flows the whole document). Omit for a
   *  display-only ruler (issue 027 step 3: "표시 전용 우선"). */
  onCommitMargins?: (mm: PageMarginsMm) => void;
}

/// Ruler — the opt-in top ruler (issue 027 step 3): a horizontal ruler over the page showing cm ticks,
/// the page width, and the left/right printable-margin markers in mm. When `onCommitMargins` is given,
/// the left/right markers become drag handles; releasing one reports the FULL new margins (mm) so the
/// host can confirm the DOCUMENT-WIDE effect before applying `SetPageMargins`. Display-only otherwise.
/// Individually importable; presentational; Korean copy; px↔mm conversion is the core `units` util only.
export function Ruler({ geom, scale, onCommitMargins }: RulerProps) {
  const editable = !!onCommitMargins;
  // Live margin px (left/right) so a drag previews before commit; resets when the geom changes.
  const [ml, setMl] = useState(geom.ml);
  const [mr, setMr] = useState(geom.mr);
  const [drag, setDrag] = useState<"l" | "r" | null>(null);
  useEffect(() => {
    setMl(geom.ml);
    setMr(geom.mr);
  }, [geom.ml, geom.mr]);

  const widthPx = geom.w * scale;

  const onDown = useCallback(
    (side: "l" | "r") => (ev: React.PointerEvent) => {
      if (!editable) return;
      ev.preventDefault();
      try {
        (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
      } catch {
        /* jsdom */
      }
      setDrag(side);
    },
    [editable],
  );

  const onMove = useCallback(
    (ev: React.PointerEvent) => {
      if (!drag) return;
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      const pageX = (ev.clientX - rect.left) / scale;
      if (drag === "l") setMl(Math.max(0, Math.min(pageX, geom.w - mr - mmToPx(5))));
      else setMr(Math.max(0, Math.min(geom.w - pageX, geom.w - ml - mmToPx(5))));
    },
    [drag, scale, geom.w, ml, mr],
  );

  const onUp = useCallback(() => {
    if (!drag) return;
    setDrag(null);
    onCommitMargins?.({ left: roundMm(pxToMm(ml)), right: roundMm(pxToMm(mr)), top: roundMm(pxToMm(geom.mt)), bottom: roundMm(pxToMm(geom.mb)) });
  }, [drag, ml, mr, geom.mt, geom.mb, onCommitMargins]);

  // cm tick marks across the page width (own-render px → mm → every 10mm).
  const totalMm = pxToMm(geom.w);
  const ticks: number[] = [];
  for (let cm = 0; cm * 10 <= totalMm; cm++) ticks.push(cm);

  return (
    <div className="hw-ruler" data-testid="hw-ruler" style={{ width: widthPx }} onPointerMove={onMove} onPointerUp={onUp}>
      <div className="hw-ruler-track">
        {ticks.map((cm) => (
          <span key={cm} className="hw-ruler-tick" style={{ left: mmToPx(cm * 10) * scale }}>
            <i className="hw-ruler-tick-mark" />
            <em className="hw-ruler-tick-label">{cm}</em>
          </span>
        ))}
        {/* printable area (between margins) */}
        <div className="hw-ruler-printable" style={{ left: ml * scale, width: (geom.w - ml - mr) * scale }} />
        <div
          className={`hw-ruler-margin hw-ruler-margin-l${editable ? " hw-ruler-margin-drag" : ""}`}
          data-testid="hw-ruler-margin-l"
          style={{ left: ml * scale }}
          title={editable ? "왼쪽 여백 (드래그하여 조절 · 문서 전체 적용)" : "왼쪽 여백"}
          onPointerDown={onDown("l")}
        />
        <div
          className={`hw-ruler-margin hw-ruler-margin-r${editable ? " hw-ruler-margin-drag" : ""}`}
          data-testid="hw-ruler-margin-r"
          style={{ left: (geom.w - mr) * scale }}
          title={editable ? "오른쪽 여백 (드래그하여 조절 · 문서 전체 적용)" : "오른쪽 여백"}
          onPointerDown={onDown("r")}
        />
      </div>
      <div className="hw-ruler-readout" data-testid="hw-ruler-readout">
        여백 좌 {roundMm(pxToMm(ml))}mm · 우 {roundMm(pxToMm(mr))}mm · 폭 {roundMm(totalMm)}mm
      </div>
    </div>
  );
}
