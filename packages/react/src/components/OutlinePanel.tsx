import { useMemo } from "react";
import type { OutlineItem } from "@tf-hwp/editor-core";
import { activeOutlineIndex } from "../outline";

export interface OutlinePanelProps {
  /** The document outline (engine headings). When empty, the panel shows a PAGE-LIST fallback (issue 046
   *  §함정: 빈 패널 금지) so a document with no detected heading still gets a working page navigator. */
  items: OutlineItem[];
  /** Total page count — drives the page-list fallback and bounds the current-page highlight. */
  pageCount: number;
  /** The page currently at the top of the viewport (0-based) — a SCROLL-POSITION calc from the workspace,
   *  independent of the 037 virtualization visible set. Highlights the outline item that contains it. */
  currentPage: number;
  /** Collapsed = a thin rail with only the expand affordance (state remembered by the host, issue 046). */
  collapsed: boolean;
  /** Toggle collapsed/expanded (the host persists it to localStorage). */
  onToggleCollapse: () => void;
  /** Jump to a page (0-based). The host wires this to its EXISTING scroll source (no new arithmetic —
   *  issue 046: 035 줌과 정합) so the outline and the page view share one scroll path. */
  onJump: (page: number) => void;
}

/// OutlinePanel — the left, collapsible document-structure nav (issue 046, TAURI-CONVERGENCE U4 승격). It
/// lists the engine's top-level headings (□/■ section labels + numbered section-band tables); clicking one
/// scrolls the page view to that heading's page, and the item on the current page is highlighted as you
/// scroll. A document with NO detected heading falls back to a plain 1..N page list (never an empty panel).
///
/// It owns NO scroll math or engine query — the parent passes the resolved `items` + `currentPage` and the
/// `onJump`/`onToggleCollapse` callbacks, so this is a pure presentational component (SDK-LAYERS L3).
export function OutlinePanel(props: OutlinePanelProps) {
  const { items, pageCount, currentPage, collapsed, onToggleCollapse, onJump } = props;

  // The active heading = the last one whose start page is at/before the current page (pure, testable).
  const activeIdx = useMemo(() => activeOutlineIndex(items, currentPage), [items, currentPage]);
  const hasHeadings = items.length > 0;

  if (collapsed) {
    return (
      <aside className="hw-outline hw-outline-collapsed" data-testid="hw-outline">
        <button
          className="hw-outline-expand"
          data-testid="hw-outline-toggle"
          onClick={onToggleCollapse}
          title="문서 구조 펼치기"
          aria-label="문서 구조 펼치기"
          aria-expanded={false}
        >
          ☰
        </button>
      </aside>
    );
  }

  return (
    <aside className="hw-outline" data-testid="hw-outline">
      <div className="hw-outline-head">
        <span className="hw-outline-title">문서 구조</span>
        <button
          className="hw-outline-collapse"
          data-testid="hw-outline-toggle"
          onClick={onToggleCollapse}
          title="문서 구조 접기"
          aria-label="문서 구조 접기"
          aria-expanded={true}
        >
          ‹
        </button>
      </div>
      <nav className="hw-outline-list" data-testid="hw-outline-list" aria-label="문서 구조">
        {hasHeadings
          ? items.map((it, i) => (
              <button
                key={`${it.section}:${it.block}:${i}`}
                className={`hw-outline-item hw-outline-l${it.level}${i === activeIdx ? " hw-outline-active" : ""}`}
                data-testid="hw-outline-item"
                data-page={it.page}
                aria-current={i === activeIdx ? "true" : undefined}
                onClick={() => onJump(it.page)}
                title={it.text}
              >
                <span className="hw-outline-text">{it.text}</span>
                <span className="hw-outline-page">{it.page + 1}</span>
              </button>
            ))
          : // 빈 패널 금지 (issue 046 §함정): 제목이 없는 문서는 페이지 목록으로 폴백.
            Array.from({ length: Math.max(pageCount, 0) }, (_, p) => (
              <button
                key={p}
                className={`hw-outline-item hw-outline-page-item${p === currentPage ? " hw-outline-active" : ""}`}
                data-testid="hw-outline-item"
                data-page={p}
                aria-current={p === currentPage ? "true" : undefined}
                onClick={() => onJump(p)}
              >
                <span className="hw-outline-text">{p + 1}쪽</span>
              </button>
            ))}
      </nav>
    </aside>
  );
}
