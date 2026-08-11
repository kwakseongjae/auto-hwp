# Fresh consumer + npm stable 증거 — 2026-08-12

## 범위

레포의 `node_modules`, lockfile, workspace 링크, 기존 `dist`, Vite `public/hwp`를 복사하지 않고
`scripts/fresh-consumer-smoke.mjs --keep`가 새 temp 루트에서 npm registry `0.0.4`만 설치했다.

## 결과

| 레인 | 결과 |
|---|---|
| Vite | 4개 `@auto-hwp/*@0.0.4` 설치, production build 성공, wasm/worker 정적 산출물 존재 |
| Next 15.5.22 | client boundary + published CSS + README의 `workspacePanel`/`buildDocContext` BYOK 브리지 타입검사와 production build 성공 |
| Node v24.14.0 | `benchmark.hwp` 8쪽, 첫 SVG 61,957 bytes, HWPX 25,216 bytes |
| Bun 1.3.8 | 동일 문서 8쪽, SVG/HWPX bytes가 Node와 동일 |
| Vite 브라우저 | browser-harness로 파일 업로드→8 SVG→7행 2열 선택→mock `PoC` 적용→undo, 전 단계 8쪽 유지 |

첫 실행에서 AI 패널을 쓰지 않는 최소 Next 예제에도 stable 타입상 `onAiRequest` prop이 필수라는 사실을
검출했다. 네트워크를 만들지 않는 `async () => []` 콜백을 명시한 뒤 **새 temp에서 처음부터** 재실행해
전체 통과했다. 이는 실패를 건너뛴 재시도가 아니라 공개 stable의 실제 타입 계약에 맞춘 소비자 예제다.

README 보완 뒤 다시 새 temp에서 실행해 `@auto-hwp/react@0.0.4`와 직접 import하는
`@auto-hwp/ai-protocol@0.0.4`가 모두 설치됐음을 확인했다. Next 소스는 README와 같은
`HwpWorkspaceProps['onAiRequest']`·`workspacePanel`·`buildDocContext(context, anchors)` 조합을 사용하고,
외부 요청 없이 타입검사와 production build를 통과했다. 성공 temp는 스크립트가 자동 삭제했다.

재현:

```bash
node scripts/fresh-consumer-smoke.mjs --keep
```

브라우저 런타임은 생성된 `examples/vite-embed`에서 `npm run preview -- --host 127.0.0.1 --port 5190`을
실행하고 browser-harness의 `upload_file`·실좌표 click·screenshot으로 확인했다. Playwright나 레포 소스
alias는 사용하지 않았다.

## npm registry 무결성

| 패키지 | shasum | unpacked |
|---|---|---:|
| `@auto-hwp/engine@0.0.4` | `675e329ef5f3d9650d38a4e57598030af98b043e` | 8,378,694 B |
| `@auto-hwp/editor-core@0.0.4` | `e962406a253e7b5a40a176d68e34711c50380acd` | 479,968 B |
| `@auto-hwp/ai-protocol@0.0.4` | `90fd41eabfc21fa15bfcf7b87bc32797d765d07b` | 119,164 B |
| `@auto-hwp/react@0.0.4` | `7afc0608208d840270f648e9e742229ac5bee227` | 1,722,417 B |

`npm view <package>@0.0.4 version dist.integrity dist.shasum dist.unpackedSize --json`으로 조회했다.

현재 소스도 네 패키지 모두 `npm pack --dry-run --json`을 통과했고, React의 `file:` 개발 의존성은
`pack:safe`가 `^0.0.4`로 바꿔 검사한 뒤 원상 복구했다. 로컬 pack hash가 registry 0.0.4와 다른 것은
main의 변경이 `CHANGELOG.md`의 Unreleased이기 때문이며, 이 차이를 0.0.4로 재발행하지 않는다.
