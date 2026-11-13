# 한컴 PDF 대비 측정 하네스 (report-only)

우리 `export-pdf`(자체 IR → `place_doc` → krilla)가 **한컴이 만든 PDF** 와 얼마나 같은지 쌍마다 잰다.
지표 정의 · 기준선 · 합격 기준안은 [`docs/HANCOM-PDF-PARITY-ROADMAP.md`](../../docs/HANCOM-PDF-PARITY-ROADMAP.md)
가 정본이다. 이 도구는 통과 · 실패를 정하지 않는다(숫자만 낸다).

## 한 줄로 다시 재기

```bash
cargo build --release -p auto-hwp-cli --features "pdf shaper rhwp"
python3 scripts/hancom-parity/sweep.py --pairs PAIRS.json --out /tmp/parity-$(date +%Y%m%d-%H%M) \
  --cli target/release/auto-hwp
```

공개 벤치마크 3쌍으로 바로 해 볼 수 있다: `--pairs scripts/hancom-parity/pairs.example.json`.

- 필요한 것: Python 3.10+(표준 라이브러리만), Poppler(`pdfinfo` · `pdftotext` · `pdftoppm` · `pdfseparate` ·
  `pdfimages` · `pdffonts`). macOS 는 `brew install poppler`.
- `--out` 은 없어야 한다(덮어쓰지 않는다). `--skip-visual` 은 화소 비교기 · 표 선을 건너뛴다(빠름).
- `--labels A,B` 로 일부만, `--jobs N` 으로 쪽 단위 화소 비교를 병렬로 돌린다(기본 3).
- 종료 코드는 도구 · 입력 오류일 때만 0 이 아니다. 변환 실패 · 쪽 수 불일치는 결과로 기록된다.
- **함정**: `scripts/verify-local.sh --full` 의 조판 오라클 재채점(`oracle-sweep --check`)은 `target/release/auto-hwp` 를
  `pdf` 기능 **없이** 다시 빌드한다. 그 뒤에는 `export-pdf` 가 없어 하네스가 변환 실패로 기록하니, 하네스 전에 위의
  `cargo build --release ... --features "pdf shaper rhwp"` 를 다시 돌린다.

## 쌍 목록 (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "pairs": [
    {
      "label": "HD-01",
      "group": "hancom-docs",
      "source": "forms/a.hwp",
      "reference": "forms/a-hancom.pdf",
      "note": "…"
    }
  ]
}
```

- 경로는 쌍 목록 파일 기준 상대 경로 또는 절대 경로. 모르는 필드 · 중복 라벨 · 없는 파일은 거부한다.
- **기준 PDF 는 한컴이 만든 것만** 넣는다(한컴독스 · 한글 데스크톱 「Hancom PDF」 · 한글 인쇄). LibreOffice · rhwp
  출력은 기준이 아니다. 비공개 문서의 쌍 목록은 저장소 밖에 둔다.

## 산출

- `OUT/summary.md` — 문서별 표(쪽 수 · 조판 대 저장 lineseg · 첫 어긋난 쪽 · 한글 누락 IR/PDF · 쪽 번호 · 줄 세로
  오차 · 잉크 F1 · 표 선 · 잘린 영역)와 전체 합계
- `OUT/summary.json` — 같은 숫자(기계용). 원본 경로 · 하위 도구 오류문은 싣지 않는다(라벨 · sha256).
  `OUT/<label>/pair.json` 의 오류문에는 로컬 경로가 들어갈 수 있다
- `OUT/<label>/` — `cand.pdf` · `cand.regions.json` · `font-report.json` · `pair.json` · `pages/pNNN/report/`(비교기
  보고서). **문서 그림이 들어 있으니 공유하지 않는다.**

## 지표 요약

| 지표               | 재는 것                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 첫 어긋난 쪽       | 한컴 k 쪽의 한글 글자 묶음과 가장 많이 겹치는 우리 쪽이 k 가 아니거나 겹침 < 90% 인 첫 쪽                                        |
| 한글 누락 IR · PDF | 한컴 PDF 의 한글 · 한자 중 `extract-text`(IR)에도 없는 비율 · IR 에는 있는데 우리 PDF 에 없는 비율                               |
| 쪽 번호            | 쪽 위아래 8% 띠에 `- N -` · `N` · `N / M` 꼴 글이 있는 쪽 수(본문이 띠까지 내려와 한 줄로 읽히면 `-N-` 꼴을 줄 안에서 찾는다)와, 쪽마다 번호 **값**을 같은 쪽끼리 대조한 수(`같은 값 쪽 / 비교한 쪽`) — 쪽 수만 세면 `1 2 1 2` 와 `1 2 3 4` 를 같게 본다 |
| 줄 세로 오차       | 같은 쪽에서 한글 키가 양쪽에 한 번씩 나오는 줄의 `pdftotext -bbox` y 차(pt)                                                      |
| 잉크 F1            | `scripts/pdf-visual-check.py` 의 `ink.f1`(±3px 정렬 뒤 검은 화소 겹침, 0~1) — 쪽 수가 같으면 모든 쪽, 다르면 글로 짝이 맞는 쪽만 |
| 표 선              | 72dpi 에서 30px 이상 이어진 세로 · 가로 선 위치가 2px · 6px 안에 있는 비율                                                       |
| 표 구조 | 세로선 6px 안 평균 · 긴 가로선 개수가 10% 안에서 같은 쪽 수(행 구조가 같은가의 대리 지표) |

한컴독스 PDF 는 라틴 · 숫자 글리프를 텍스트로 뽑을 수 없는 경우가 많아 글자 · 줄 지표는 한글 음절 · 한자만 본다.
