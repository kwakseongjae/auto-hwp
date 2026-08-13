# Vercel main 자동 production 배포 증거

- 이슈: [#26](https://github.com/kwakseongjae/auto-hwp/issues/26)
- 구현 PR: [#27](https://github.com/kwakseongjae/auto-hwp/pull/27)
- main merge: `dd527d8c92c00573541556aacf5a1711d45650df`
- 자동 run: [31680139716](https://github.com/kwakseongjae/auto-hwp/actions/runs/31680139716)

## 트리거와 대상

- event: `push` — `workflow_dispatch` 수동 실행이 아니다.
- head SHA: `dd527d8c92c00573541556aacf5a1711d45650df` — main merge와 동일하다.
- Vercel native Git deployment는 계속 `deploymentEnabled=false`다.
- workflow가 push를 `DEPLOY_TARGET=production`, `PROD_FLAG=--prod`, `vercel-production` environment로
  정규화한 뒤 Rust→wasm→JS→Next prebuilt 순서로 배포했다.

## 결과

- run: 6m30s success
- prebuilt deployment: `https://auto-7d0tfbjl1-kwakseongjaes-projects.vercel.app`
- production alias `https://autohwp.com/`: HTTP 200
- `https://autohwp.com/og.png`: HTTP 200
- canonical: `https://autohwp.com`
- 실제 응답에서 CSP, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`를 확인했다.

관련 main push만 자동 배포 대상으로 삼으며 docs-only push는 path filter에서 제외한다. 수동 dispatch의
preview 기본값과 명시적 production 선택은 유지한다.
