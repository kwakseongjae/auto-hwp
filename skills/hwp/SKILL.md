---
name: hwp
description: >-
  HWP/HWPX 문서를 로컬 tf-hwp 엔진(CLI)으로 열람·변환·편집한다 — 사이트/서버 없이 결과물만 활용.
  트리거: "hwp를 pdf로", "hwpx 변환", "한글 문서 텍스트 추출", "hwp 렌더/미리보기", "hwp 표 채워/바꿔줘",
  ".hwp 열어줘" 등 HWP 파일을 다루는 모든 요청.
---

# hwp — 로컬 HWP 엔진 스킬

tf-hwp CLI(`tf-hwp`)로 HWP5/HWPX를 **전부 로컬에서** 처리한다. 문서는 어디에도 전송되지 않는다.

## 준비 (1회)

```bash
which tf-hwp || cargo install --git https://github.com/kwakseongjae/tf-hwp tf-hwp-cli --features rhwp,shaper,pdf
# 실패 시(서브모듈): git clone --recurse-submodules https://github.com/kwakseongjae/tf-hwp
#                    && cargo install --path tf-hwp/crates/tf-hwp-cli --features rhwp,shaper,pdf
```

`which tf-hwp` 로 설치 확인 후 없을 때만 설치를 제안하라(수 분 소요 — 사용자에게 고지).

## 명령 팔레트 (전부 `tf-hwp <서브커맨드> <파일>`)

| 하고 싶은 것 | 명령 |
|---|---|
| 포맷/열림 확인 | `tf-hwp detect 문서.hwp` · `tf-hwp info 문서.hwp` |
| 텍스트 추출 | `tf-hwp extract-text 문서.hwp` |
| **PDF 변환** (레이아웃 보존) | `tf-hwp export-pdf 문서.hwp -o 문서.pdf` |
| HTML 변환 (시맨틱 리플로) | `tf-hwp export-html 문서.hwp -o 문서.html` |
| 페이지 미리보기(SVG) | `tf-hwp own-render 문서.hwp --page 0 --out p.svg` (--page 생략=전체) |
| LLM용 구조 컨텍스트 | `tf-hwp ai-context 문서.hwp` (표=그리드 + `[s/b]` 블록 주소) |
| 편집(찾아바꾸기·표 채우기 등) | `tf-hwp edit` 계열 — `tf-hwp --help` 로 서브커맨드/인자 확인 후 사용 |

편집 워크플로: 먼저 `ai-context` 로 구조와 `[s/b]` 주소를 읽고 → 편집 커맨드로 반영 → `export-*` 로
결과물. 여러 파일 배치 변환은 셸 루프로.

## 정직 고지 (항상 사용자에게 전달)
- 암호(password) `.hwp` 는 열 수 없다(정직 거부). 배포용(DRM)은 열린다.
- **PDF의 수식·차트는 자리표시 상자**로 나간다(HTML/SVG는 실렌더) — 해당 요소가 있으면 미리 알릴 것.
- 함초롬 등 상용 서체는 OFL 대체(나눔 계열)로 렌더된다. 저장 포맷은 HWPX(.hwp 재저장 없음).
- 페이지 수 게이트는 실물 정부 양식 벤치마크 기준(8==8·18==18) — 임의 문서의 완전 일치 보증은 아니다.

## 대안 표면 (요청이 이 스킬 범위를 넘으면 안내)
- AI 도구에 상시 장착: `hwp-mcp` 로컬 MCP 서버 — `docs/MCP-GUIDE.md`.
- 웹사이트 임베드: `@tf-hwp/engine`/`@tf-hwp/react` npm — `docs/EMBED-GUIDE.md`.
