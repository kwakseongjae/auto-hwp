---
name: 조판 격차 (layout gap)
about: 내 공문서에서 auto-hwp 조판이 한/글과 다르게 나옵니다
title: "[조판] "
labels: layout
---

<!--
⚠️ 문서 파일을 첨부하지 마세요.
   공문서·양식은 재배포 규율이 걸려 있고, 작성 완료본에는 개인정보가 들어 있습니다.
   아래 **수치와 구조 특징만** 으로 우리가 재현 가설을 세울 수 있습니다.

먼저 로컬 벤치를 돌리세요 (문서는 컴퓨터를 벗어나지 않습니다):

    cp <내 문서>.hwp benchmarks/local/
    scripts/bench-local.sh

스크립트가 마지막에 "이슈에 붙여넣기용" 마크다운 표를 만들어 줍니다. 그걸 §1에 붙이세요.
-->

## 1. 측정 결과

<!-- scripts/bench-local.sh 출력의 붙여넣기용 표를 그대로 붙입니다 -->

| # | 판정 | 우리 쪽 | 한컴 쪽 | Δ | 문단 | 줄 정확% | 줄 ±1% | 셀 정확% | 구조 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
|   |    |    |    |   |    |    |    |    |    |

- auto-hwp 버전 / 커밋:
- OS:

## 2. 문서의 구조 특징 (파일 없이 재현하기 위한 정보)

문서 **내용**이 아니라 **형태**를 적어 주세요.

- [ ] 표가 페이지를 넘어감 (다쪽 표)
- [ ] 표 안에 표 (중첩 표)
- [ ] 셀 세로 정렬이 가운데/아래
- [ ] 각주 / 미주가 있음
- [ ] 그림이 "어울림(Square)" 또는 "글 뒤로/앞으로"
- [ ] 머리말 / 꼬리말이 있음
- [ ] 강제 쪽 나누기, 구역(section)이 여러 개
- [ ] 수식
- [ ] 세로쓰기 / 다단
- [ ] 기타:

원본 형식: <!-- .hwp / .hwpx / 한/글에서 다른 이름으로 저장한 변환본 -->
같은 문서의 .hwp / .hwpx 쌍이 있고 결과가 다르면 두 줄 다 §1 표에 넣어 주세요.

## 3. 어디서 갈리는가 (알면 좋고, 몰라도 됩니다)

```bash
# 페이지별 SVG 를 뽑아 육안 비교
cargo run --release -p auto-hwp-cli --features rhwp,shaper -- own-render <파일> --page 3 --out /tmp/p3.svg

# 표 행 높이 대조 (우리 예약 vs 한컴 실측)
cargo run --release -p auto-hwp-cli --features rhwp,shaper -- layout-check <파일> --rows <섹션>/<블록>

# 셀 줄수 불일치 상세
cargo run --release -p auto-hwp-cli --features rhwp,shaper -- layout-check <파일> --cells all
```

- 처음 갈리는 페이지:
- 그 페이지에서 눈에 띄는 것:

## 4. 문서 공유 여부

- [ ] 이 문서는 **공개 배포된 정부/공공 양식**이며 출처 URL 을 적을 수 있습니다 → URL:
- [ ] 공개 문서가 아닙니다 (첨부하지 않겠습니다 — 위 수치로만 진행해 주세요)

> 민감 문서(작성 완료본·개인정보 포함)는 공개 코퍼스로 승격하지 않습니다.
> 로컬 검증용으로만 `corpus/private/`(gitignore) 에 두는 규율을 따릅니다.
> 자세한 내용은 [CONTRIBUTING.md — 조판 이슈 기여](https://github.com/kwakseongjae/auto-hwp/blob/main/CONTRIBUTING.md#조판-이슈-기여) 참조.
