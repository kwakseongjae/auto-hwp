# 오픈소스 런칭 소유자 승인

이 파일은 사람이 판단해야 하는 두 항목을 코드 검증과 분리한다. 승인 전에는
`docs/launch/STATUS.json`의 해당 gate를 `pass`로 바꾸지 않는다.

## 개인정보 문구

- 검토 대상: `https://autohwp.com/privacy`에 배포될 `apps/hwp-lab/src/app/privacy/page.tsx`
- 핵심 사실: 문서 엔진·파일 처리는 브라우저 로컬, 데모 AI를 선택한 경우에만 선택 범위의 문맥과 지시가
  Vercel 경유 OpenRouter로 전송된다.
- rate-limit 고지: IP당 기본 20회/UTC일, 전체 기본 400회/UTC일. Upstash가 없으면 인스턴스별
  best-effort이므로 비용의 절대 상한이라고 주장하지 않는다.
- 로그·보유·철회·연락처 문구와 실제 운영 정책이 일치하는지 소유자가 확인한다.

- [ ] 소유자가 개인정보 문구와 실제 운영을 대조해 승인함
- 승인자/시각:
- 필요한 수정:

승인 뒤 이 파일에 승인자·시각을 기록하고 `privacy_copy_owner_review`의 evidence로 사용한다.

## 런칭 문구

- 정본: `docs/launch/CONTENT-BRIEF.md`
- 한 문장: “한글 문서를 남의 서비스에 맡기지 않고, 브라우저·내 서버·내 에이전트에서 같은 Rust
  코어로 열고, 고치고, 검토하고, 다시 내보내는 오픈소스 문서 엔진과 편집기 SDK.”
- 금지 주장: 한컴 100% 호환, AI가 없어도 외부 전송이 있다는 암시, 082 실물 검증 전 `.hwp` 재저장 지원,
  main의 미발행 SDK 기능을 npm stable 기능처럼 설명하는 문구.
- 공개 npm은 `0.0.4` stable이며, 이후 package 소스 변경은 다음 lockstep npm 릴리스까지
  `CHANGELOG.md`의 Unreleased다.

- [ ] 소유자가 한국어/영어 README와 콘텐츠 브리프의 핵심 주장·금지 주장을 승인함
- 승인자/시각:
- 필요한 수정:

승인 뒤 이 파일에 승인자·시각을 기록하고 `launch_copy_owner_approval`의 evidence로 사용한다.
