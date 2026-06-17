# 004 — fill-from-source NodeId 인용 + prompt caching

- 상태: **open**
- 우선순위: P3
- 영역: AI 레이어 (PLAN §3.2)

## 문제
- **fill-from-source**: AI가 문서 내용을 근거로 작성할 때 출처 노드(NodeId)를 인용하도록 → 환각 감소, 검증 가능성. 현재 `to_markdown`은 reading-order 평문만 제공(노드 id 없음).
- **prompt caching**: 문서 outline/맥락을 Anthropic prompt cache로 재사용해 BYOK 비용/지연 절감(`AnthropicProvider`).

## 접근(구현 시)
1. `to_markdown`을 NodeId 주석 포함 구조보존 Markdown으로 확장(표=그리드, 안정 노드 id).
2. ai_fill 제안에 `source_refs: Vec<NodeId>` 첨부 → diff 미리보기에서 출처 표시.
3. AnthropicProvider: system+문서 outline에 `cache_control` 적용.

## 수용 기준
- 제안 문단마다 인용 근거 노출, 동일 문서 반복 호출 시 캐시 적중.
