# 029 — R4-2: 실통합 인수인계 문서 (창업지원도움e 개발자용)

- 상태: **open**
- 우선순위: R4-P1
- 영역: docs-only (+ 검증용 스크립트 1개 허용)
- 선행: 026·027 (done). 병렬 가능: 028 (파일 disjoint)
- 배경: **실통합은 사용자가 직접 수행한다** — 우리는 "따라 하면 되는" 인수인계 문서를
  전달한다. 독자는 business_plan_k(Next.js 15+/OpenNext Cloudflare) 개발자.

## 목표
`docs/INTEGRATION-HANDOVER.md` (한국어) — **이 문서만 읽고 외부 Next.js 앱에
업로드→렌더→선택→바이브편집→HTML/PDF를 통합할 수 있어야 한다**. 전부 apps/hwp-lab에서
실검증된 사실만 쓰고(코드·커밋 참조), 추측/미검증 서술 금지.

## 필수 목차 (각 절은 "정확한 커맨드/코드"와 "왜"를 함께)
1. **아키텍처 5분 요약** — SDK-LAYERS 도식 인용 + "무엇을 안 가져가도 되는가"(L3 선택,
   LLM 벤더 자유).
2. **패키지 준비** — 현 배포 형태(미출판, file:/npm pack), **빌드 체인 순서 필수**:
   engine pkg 재생성(015 레시피, wasm-bindgen 0.2.125 고정) → editor-core build →
   ai-protocol build → react build. (react dist가 두 패키지의 dist entry를 참조 — 순서
   누락 시 vite "Failed to resolve entry" — 실측 사고 사례 명시.)
3. **Next.js 통합 레시피** — apps/hwp-lab에서 검증된 그대로: transpilePackages,
   resolve.symlinks=false, `hwp_wasm.js`에 parser.url=false(11.5MB 중복 방출 차단),
   Next 15 고정 사유(16 Turbopack은 webpack 설정 무시), public/hwp+public/fonts 정적
   에셋 + copy-wasm/copy-fonts/fetch-fonts 스크립트, dynamic ssr:false, `.next` 캐시
   gotcha(패키지 갱신 후 rm -rf .next).
4. **LLM 프록시 계약** — ai-protocol 사용법(buildSystemPrompt/buildUserMessage/
   validateRequest/validateResponse), route.ts를 "참조 구현"으로 링크, 벤더 자유·키
   서버 전용(R6) 의무, intent 화이트리스트 확장 방법.
5. **폰트** — 기본 NanumGothic 자동 적용 구조, 카탈로그 fetch(sha 핀), 업로드,
   **라이선스 의무(R8)**: FONT-CATALOG 링크 + "재배포 가능 폰트만 서빙" 규칙.
6. **보안 의무** — sanitizeSvg 경유 강제(R7 — 직접 렌더 시에도), `<document-content>`
   펜스(R5), wasm 트랩 복구(resetEngine 규약), 업로드 파일 하드닝은 엔진 내장(014) 사실.
7. **검증 체크리스트** — 통합 후 QA.md ①~⑨ 재사용 + Playwright 스모크 이식 가이드.
8. **알려진 한계·수동확인 목록** — 누적된 manualVerification 전부 취합(IME 실기기,
   룰러 여백 confirm, 분할표 열핸들 육안, 서체 변경 육안, 실LLM 스모크, 번들 3.5MB
   gzip/wasm-opt 미적용, 마킹은 셀·블록 단위 등). **숨기지 말 것** — 인수인계의 신뢰가 핵심.
9. **트러블슈팅 표** — 이 세션에서 실제 겪은 사고들: dist entry 해석 실패/스테일 .next/
   포트 점유/wasm pkg 부재 에러 메시지 각각의 증상→원인→해결.
10. **부록** — 커밋 지도(주요 기능→커밋 해시), 이슈 문서 색인, 게이트 실행법.

## 검증 (문서가 "실행 가능"함을 증명)
- `scripts/handover-verify.sh`(신규, tracked): 문서 §2~§3의 커맨드 시퀀스를 **그대로**
  스크립트화해 클린 상태(아티팩트 제거 후)에서 lab 기동→curl 200→종료까지 1회 재현.
  문서와 스크립트의 커맨드가 어긋나면 실패다(문서≠코드 드리프트 방지).
- 문서 내 모든 파일 경로/함수명/커밋 해시가 실재하는지 검증자가 grep 대조.

## 수용 기준
- [ ] INTEGRATION-HANDOVER.md 10개 절 완비, 전 커맨드 실검증(스크립트 재현 통과)
- [ ] 한계·수동확인 목록이 세션 누적분을 전부 포함(축소 금지)
- [ ] 참조(경로/심볼/커밋) 전수 실재
- [ ] handover-verify.sh tracked + 클린 상태에서 exit 0
- [ ] 코드 무수정(docs+scripts만) — 게이트 자동 유지

## 함정
- "될 것이다" 금지 — apps/hwp-lab에서 안 해본 것은 쓰지 말고 '미검증' 표기.
- business_plan_k 레포는 읽기 전용 참고(경로 인용만) — 수정 금지.
- 문서가 길어지는 것보다 빠뜨리는 게 죄다 — 단, 각 절은 커맨드 우선·산문 최소.
