import type { Box } from "@auto-hwp/editor-core";

/// GhostPreviewOverlay — 적용 **전** 결과를 그 자리에 반투명하게 얹는 레이어 (이슈 3).
///
/// 종전 제안 카드는 텍스트 요약과 "위치 보기"(점프+플래시)뿐이라, 사용자는 적용한 뒤에야 결과를 봤다.
/// 이 레이어는 카드에 hover 하거나 "미리 보기"를 켜면 대상 셀/문단의 **실제 렌더 박스**(어댑터 기하)에
/// 제안 값을 고스트로 그린다. pointer-events:none — 클릭/선택을 절대 가로채지 않는다(SelectionOverlay
/// 와 같은 규율). 좌표는 own-render PAGE px + `scale`.
///
/// 정직성: 그릴 수 있는 것만 그린다. 삽입/삭제처럼 적용 전에 자리가 없는 편집은 editor-core 의
/// `intentGhosts` 가 애초에 대상에서 뺀다 — 여기엔 도달하지 않는다.

/** One resolved ghost: where to draw + what the edit would leave there. */
export interface GhostBox {
  /** The Intent's position in the proposal (keys the hover back to its card). */
  index: number;
  page: number;
  box: Box;
  text: string;
}

export interface GhostPreviewOverlayProps {
  ghosts: GhostBox[];
  page: number;
  scale: number;
}

export function GhostPreviewOverlay({ ghosts, page, scale }: GhostPreviewOverlayProps) {
  const mine = ghosts.filter((g) => g.page === page);
  if (mine.length === 0) return null;
  return (
    <div className="hw-ghosts" data-testid="hw-ghosts" aria-hidden>
      {mine.map((g) => (
        <div
          key={g.index}
          className="hw-ghost"
          data-testid={`hw-ghost-${g.index}`}
          style={{ left: g.box.x * scale, top: g.box.y * scale, width: g.box.w * scale, height: g.box.h * scale }}
        >
          <span className="hw-ghost-text">{g.text}</span>
        </div>
      ))}
    </div>
  );
}
