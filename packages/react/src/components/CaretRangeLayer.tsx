import { useEffect, useRef } from "react";
import type { ActiveCaret, EditorCore } from "@auto-hwp/editor-core";

export interface CaretRangeLayerProps {
  /** 헤드리스 코어 — 이 레이어는 `core.caret` 를 **직접** 구독한다(030 격리: props 로 흘려받지 않는다). */
  core: EditorCore;
  /** 이 레이어가 붙은 페이지(다른 페이지의 선택은 여기 아무것도 그리지 않는다). */
  page: number;
  /** 렌더 px / viewBox px — 페이지 px → 클라이언트 px. 줌만이 이 값을 바꾼다. */
  scale: number;
}

/// CaretRangeLayer — 글자 **범위 선택**의 하이라이트. CaretLayer(053)와 같은 격리 규율을 따르되 한 걸음 더
/// 간다: 컨테이너 `<div>` 는 **항상 마운트**되고 사각형들은 자식 노드로 **직접**(ref) 만들어 넣는다.
///   · 그래서 이 컴포넌트는 마운트 이후 **단 한 번도 리렌더되지 않는다** — Shift+방향키를 아무리 눌러도
///     React 커밋 0(워크스페이스/시트 render-0 카운터가 잠그는 규율).
///   · 사각형 수는 선택이 걸친 줄 수만큼이라 보통 1~3개다. 재사용 가능한 자식은 스타일만 덮어쓰고 남는
///     자식은 지운다(노드 churn 최소화).
/// 캐럿 막대(z-index 7)보다 아래(z-index 5)에 깔려 막대가 하이라이트 위에 보인다.
export function CaretRangeLayer({ core, page, scale }: CaretRangeLayerProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // 최신 scale/page 를 보는 draw 를 ref 에 담아 둔다 — 구독을 다시 걸지 않고도 줌 변화를 따라간다.
  const drawRef = useRef<(s: ActiveCaret | null) => void>(() => {});
  drawRef.current = (s: ActiveCaret | null) => {
    const el = ref.current;
    if (!el) return;
    const rects = s && s.rects.length ? s.rects.filter((r) => r.page === page) : [];
    // 자식 재사용: 필요한 만큼 만들고, 남는 건 잘라낸다.
    while (el.childElementCount > rects.length) el.removeChild(el.lastChild!);
    while (el.childElementCount < rects.length) {
      const box = document.createElement("div");
      box.className = "hw-selrange-box";
      el.appendChild(box);
    }
    rects.forEach((r, i) => {
      const box = el.children[i] as HTMLElement;
      box.style.left = `${r.x * scale}px`;
      box.style.top = `${r.top * scale}px`;
      box.style.width = `${r.width * scale}px`;
      box.style.height = `${r.height * scale}px`;
    });
  };

  useEffect(() => {
    const onCaret = (s: ActiveCaret | null) => drawRef.current(s);
    onCaret(core.caret.get()); // 마운트/줌 변경 시 현재 상태 동기화
    return core.caret.onChange(onCaret);
  }, [core, page, scale]);

  return <div ref={ref} className="hw-selrange" data-testid="hw-selrange" aria-hidden />;
}
