import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition, type MenuViewport } from "../contextMenuPosition";

/** One list-menu entry — an action (a clickable row that delegates to an existing handler) or a divider. */
export type ContextMenuItem =
  | {
      type: "action";
      /** Stable key + testid suffix (`hw-ctx-<key>`). */
      key: string;
      label: string;
      /** Optional leading glyph. */
      icon?: string;
      /** Disabled rows are skipped by keyboard nav and show a reason tooltip (미지원은 조용한 무시 금지). */
      disabled?: boolean;
      title?: string;
      onSelect: () => void;
    }
  | { type: "separator"; key: string };

export interface ContextMenuProps {
  /** Desired anchor (client px — where the pointer went down). Clamped to the viewport after measuring. */
  x: number;
  y: number;
  /** List items (with ↑↓/Enter keyboard nav). Provide EITHER `items` OR `children`. */
  items?: ContextMenuItem[];
  /** Custom content (e.g. the background 표 추가 grid picker). Rendered instead of the item list. */
  children?: React.ReactNode;
  /** A short header label shown above `children` (custom mode only). */
  heading?: string;
  /** Close the menu (Esc / outside click / scroll / after an action). */
  onClose: () => void;
  /** Positioning viewport (default = the window). */
  viewport?: MenuViewport;
}

// Initial estimate before the menu measures itself (first paint is close; it snaps after mount).
const EST_W = 200;
const EST_H = 160;

/// ContextMenu — the issue-039 right-click menu surface. It is a POSITIONAL, self-closing popup that
/// renders EITHER a keyboard-navigable action list (`items`) or custom content (`children`, e.g. the
/// background 표 추가 picker). It owns ONLY the surface concerns the issue demands — viewport-edge clamp
/// (measures itself, re-feeds the size), Esc / outside-click / scroll close, and ↑↓/Enter list nav — and
/// NEVER any edit logic: every action is a caller-supplied thunk that delegates to an existing intent /
/// EditController path (신규 액션 0). Presentational + individually importable.
export function ContextMenu({ x, y, items, children, heading, onClose, viewport }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: EST_W, h: EST_H });
  // The highlighted action index (list mode). -1 = nothing highlighted (mouse-driven until a key is pressed).
  const [active, setActive] = useState(-1);

  const actionIdx = useCallback(
    (): number[] => (items ?? []).map((it, i) => (it.type === "action" && !it.disabled ? i : -1)).filter((i) => i >= 0),
    [items],
  );

  // Measure the menu after render; re-feed the real size so the clamp is exact (converges via the guard).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (Math.abs(r.width - size.w) > 0.5 || Math.abs(r.height - size.h) > 0.5)) {
      setSize({ w: r.width, h: r.height });
    }
  });

  // Close on outside pointerdown, any scroll, and a window resize (native-menu behaviour). Capture phase so
  // a scroll on the inner canvas (which doesn't bubble to window) still closes it.
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

  // Keyboard: ↑/↓ move the highlight over enabled actions, Enter/Space activate, Esc close. Capture phase +
  // stopPropagation so these keys are consumed by the menu and never leak to the 035 zoom / 036 cell-nav /
  // 021 Esc window listeners while the menu owns focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (!items) return; // custom (children) mode: only Esc is handled here
      const idxs = actionIdx();
      if (idxs.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((cur) => {
          const pos = idxs.indexOf(cur);
          if (e.key === "ArrowDown") return idxs[(pos + 1 + idxs.length) % idxs.length] ?? idxs[0];
          return idxs[(pos - 1 + idxs.length) % idxs.length] ?? idxs[idxs.length - 1];
        });
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const cur = active >= 0 ? active : idxs[0];
        const it = items[cur];
        if (it && it.type === "action" && !it.disabled) {
          e.preventDefault();
          e.stopPropagation();
          it.onSelect();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items, active, actionIdx, onClose]);

  const vp = viewport ?? { width: typeof window !== "undefined" ? window.innerWidth : 1024, height: typeof window !== "undefined" ? window.innerHeight : 768 };
  const pos = clampMenuPosition(x, y, size.w, size.h, vp);

  const activate = (it: Extract<ContextMenuItem, { type: "action" }>) => {
    if (it.disabled) return;
    it.onSelect();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="hw-ctxmenu"
      data-testid="hw-context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      // The menu is an "inside" region: swallow pointerdown so it never reads as an outside/deselect click.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items
        ? items.map((it) =>
            it.type === "separator" ? (
              <div key={it.key} className="hw-ctxmenu-sep" role="separator" />
            ) : (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className={`hw-ctxmenu-item${active === items.indexOf(it) ? " hw-ctxmenu-active" : ""}`}
                data-testid={`hw-ctx-${it.key}`}
                disabled={it.disabled}
                title={it.title ?? it.label}
                onMouseEnter={() => setActive(items.indexOf(it))}
                onClick={() => activate(it)}
              >
                {it.icon && <span className="hw-ctxmenu-icon" aria-hidden>{it.icon}</span>}
                <span className="hw-ctxmenu-label">{it.label}</span>
              </button>
            ),
          )
        : (
          <>
            {heading && <div className="hw-ctxmenu-head">{heading}</div>}
            {children}
          </>
        )}
    </div>
  );
}
