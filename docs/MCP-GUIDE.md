# hwp-mcp — 로컬 MCP 서버 가이드 (셀프호스팅, 우리 서버 0)

`hwp-mcp`는 auto-hwp 엔진을 **Model Context Protocol** 로 노출하는 **로컬 stdio 바이너리**다.
사용자가 자기 컴퓨터에 설치해 자기 AI 도구(Claude Code/Desktop, Cursor 등)에 붙인다 —
문서가 외부로 전송되지 않고, 프로젝트 쪽에 서버·트래픽·운영 부담이 전혀 없다.

## 설치

```bash
# 방법 1 — git에서 바로 (Rust 툴체인 필요; 서브모듈 포함 자동 클론)
cargo install --git https://github.com/kwakseongjae/auto-hwp hwp-mcp --features rhwp

# 방법 2 — 클론 후 (방법 1이 서브모듈 문제로 실패할 때)
git clone --recurse-submodules https://github.com/kwakseongjae/auto-hwp && cd auto-hwp
cargo install --path crates/hwp-mcp --features rhwp
```

`--features rhwp` 가 **바이너리 `.hwp`(HWP5) 열기**와 `render_page`(SVG)를 켠다 — 생략하면 HWPX만.

## 연결

```bash
claude mcp add auto-hwp -- hwp-mcp          # Claude Code
# Claude Desktop / Cursor: MCP 설정에 command "hwp-mcp" (stdio) 등록
```

이후 해당 AI 도구에서: *"~/문서/신청서.hwp 열어서 표 채우고 PDF로 저장해줘"* — 전부 로컬 실행.

## 도구 (15종)

| 도구 | 역할 |
|---|---|
| `open_document` / `close_document` | .hwp/.hwpx 열기(HWP5는 편집가능 HWPX로 변환)/닫기 |
| `get_context` | 구조 보존 Markdown(표=그리드, `[s/b]` 앵커) — LLM이 문서를 읽는 창 |
| `extract_text` / `page_count` / `render_page` | 평문 추출 · 쪽수 · 페이지 SVG |
| `apply_content` / `propose_content` / `commit_proposal` | 편집 적용(1 undo) · 프리뷰 제안 · 승인 커밋 |
| `find_text` / `replace_text` | 찾기 / 찾아바꾸기(서식 보존) |
| `undo` / `redo` | 편집 취소/재실행 (스냅샷, 메모리 버짓 071) |
| `export_hwpx` / `export_pdf` | HWPX 저장(무편집 영역 바이트 보존) · 레이아웃 보존 PDF |

## 정직 고지 (README "알려진 제약"과 동일)
- 암호(password) `.hwp` 미지원(정직 거부). 배포용(DRM)은 복호 지원.
- PDF에서 수식·차트는 자리표시 상자(화면/HTML은 실렌더). PDF 한글 폰트는 시스템/번들 OFL face 탐색.
- 저장 포맷은 HWPX(.hwp 재저장 없음).

## 전송 모드 (기본 = stdio, 나머지는 고급)
- **stdio(기본)**: 위 레시피. 로컬 프로세스, 네트워크 0.
- `--http`: 루프백 전용 토큰 파일 방식(로컬 데스크톱 앱 연동).
- `--http-network`: 컨테이너 서비스 모드(환경변수 fail-closed·workspace 감금 — 사설망 전용).
  프로젝트가 호스팅하는 공용 서버는 **없다** — 셋 다 사용자가 자기 인프라에서 돌리는 것이다.
