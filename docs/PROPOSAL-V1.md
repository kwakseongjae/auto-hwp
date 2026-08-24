# Proposal v1 — 검증 가능한 AI 편집 트랜잭션

Proposal v1은 Web, Tauri, MCP, SDK가 공유하는 외부 편집 계약이다. AI가 만든 결과를 바로 문서에
적용하지 않고, 엄격히 해석한 Intent 묶음을 격리된 문서 복제본에서 먼저 실행한 다음 동일한
세션·문서·revision에만 원자적으로 커밋한다.

## 계약

`ProposeIntents`의 결과에는 다음 필드가 항상 존재한다.

- `proposal_version`, `proposal_id`, `digest`
- `session_id`, `document_id`, `base_revision`
- 기본값까지 채운 `intents`
- `affected_addresses`, `affected_pages`
- `capabilities`, `risks`, `warnings`

중첩 Intent는 schema v0의 `deny_unknown_fields` decoder를 다시 통과한다. 알 수 없거나 malformed인
필드, lifecycle/query/undo/redo, 중첩 proposal은 scratch 실행 전에 거부한다. `AiContent`는 허용된
authoring DSL이지만 즉시 typed 값으로 파싱·정규화하고 같은 scratch에서 op-bus로 컴파일한다.

Preview는 live document, revision, undo/redo history를 바꾸지 않는다. batch의 중간 Intent가 실패하면
격리된 scratch만 폐기한다. `CommitProposal`은 proposal id와 expected/base/live revision 및
session/document identity가 모두 일치할 때만 이미 검증한 snapshot을 한 undo 단위로 교체한다.
reopen, 다른 편집, undo, redo, 다른 commit 뒤의 proposal은 stale이며 실패한 proposal은 재사용할 수 없다.

## Digest와 신뢰 경계

digest는 재귀적으로 object key를 정렬한 UTF-8 JSON에 대한 FNV-1a 64-bit 값이다. Rust와 TypeScript
recorded fixture는 `fnv1a64:12f669d02eea3d03`을 공유한다. 이 값은 transport 간 정규화 parity를
확인하는 checksum이지 인증 수단이 아니다. 커밋 권한은 엔진 내부에만 보관한 pending snapshot과
session/document/revision binding에서 나온다. 외부에서 DTO를 고치거나 같은 digest를 만들더라도
엔진이 보관한 정확한 pending proposal이 아니면 커밋할 수 없다.

## Surface 흐름

```text
Web / Tauri / MCP / SDK
  → ProposeIntents(typed Intent[])
  → strict decode + normalize
  → detached scratch apply/validate
  ← Proposal v1 DTO
  → CommitProposal(proposal_id, expected_revision)
  → binding 재검사 + one-unit snapshot commit
```

필드별 wire 예제와 오류 표는 [INTENT-SCHEMA.md](INTENT-SCHEMA.md) §6.2를 정본으로 삼는다.
