# auto-hwp 에이전트 연동 시작 프롬프트

README·autohwp.com 문서 허브·런칭 게시물의 **복사 버튼이 공유할 정본**이다. 공개 표면에 옮길 때
URL이나 검증 단계를 줄이지 않는다.

```text
auto-hwp를 이 프로젝트에 통합해줘.

먼저 아래 문서를 읽고 문서에 없는 API를 추측하지 마.
- https://autohwp.com/llms.txt
- https://autohwp.com/docs/llm
- https://autohwp.com/docs/embed

코드를 고치기 전에 내 프로젝트의 프레임워크와 런타임, 필요한 기능
(열기/수동 편집/AI 편집/PDF·HTML·HWPX 내보내기), 폰트·CSP·오프라인 조건을 확인해.
현재 공개 npm stable 버전을 정확히 고정하고 가장 작은 통합부터 구현해.

문서 바이트와 편집 엔진은 브라우저 또는 내 인프라에서 실행해야 한다. AI가 필요하면 API 키를
클라이언트에 두지 말고 내 서버 프록시에서 @auto-hwp/ai-protocol의 buildDocContext,
validateRequest, validateResponse를 사용해. AI를 쓰지 않는 경로에는 네트워크 호출을 추가하지 마.

마지막에 typecheck와 production build, 실제 HWP/HWPX 파일 1개의 열기·렌더·편집·내보내기 smoke를
실행해. 수정 파일, 실행한 검증, 아직 지원하지 않는 범위와 데이터가 외부로 나가는 지점을 보고해.
```

## 배치 위치

1. README의 첫 통합 코드보다 위: `AI 에이전트에게 맡기기` 접기/복사 블록.
2. `/docs` 허브의 통합 그룹 첫 카드: 같은 원문을 복사하는 버튼.
3. 한국어·영어 런칭 게시물의 마지막 CTA.
4. `llms.txt`는 이 프롬프트를 다시 싣지 않고 정본 문서로 라우팅만 한다.
