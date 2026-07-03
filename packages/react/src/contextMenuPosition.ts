/// contextMenuPosition — the PURE viewport-clamp for the issue-039 right-click menu. Given the desired
/// anchor point (client px, where the pointer went down), the measured menu size, and the viewport size,
/// it returns the top-left so the WHOLE menu stays inside the viewport (§함정: 뷰포트 경계 클램프). It
/// FLIPS the menu to open leftwards/upwards of the anchor when it would overflow the right/bottom edge
/// (native-menu behaviour), then clamps to the margin as a final guard. No DOM, no React — unit-testable.

export interface MenuViewport {
  width: number;
  height: number;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/// Clamp a context menu to the viewport. `x`/`y` is the desired top-left (the pointer point). `w`/`h` is
/// the measured menu box. Opens right+down of the point by default; flips to left/up if that side has more
/// room and the default would clip; finally clamps within `[margin, viewport - size - margin]`.
export function clampMenuPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  viewport: MenuViewport,
  margin = 6,
): MenuPosition {
  const { width: vw, height: vh } = viewport;

  // Horizontal: prefer opening to the RIGHT of the point. If it would overflow the right edge AND there is
  // more room to the left, flip so the menu's right edge sits at the point instead.
  let px = x;
  if (x + w + margin > vw && x - w >= margin) px = x - w;

  // Vertical: prefer opening DOWNWARD. Flip up if it would overflow the bottom edge and there is room above.
  let py = y;
  if (y + h + margin > vh && y - h >= margin) py = y - h;

  // Final clamp so the whole menu is inside the viewport even when neither side fully fits (tiny viewport).
  const maxX = Math.max(margin, vw - w - margin);
  const maxY = Math.max(margin, vh - h - margin);
  px = Math.min(Math.max(px, margin), maxX);
  py = Math.min(Math.max(py, margin), maxY);
  return { x: px, y: py };
}
