# CURRENT STATE — 단일 복원 지점

> 새 세션·compact 후 **이 파일 하나만 읽으면 재개할 수 있어야 한다.**
> 갱신 시점: 작업 단위 완료 · 결정 확정 · 머지 직후 (보고보다 먼저). 프로토콜: `AGENTS.md` §세션 연속성.

- 기준 커밋: `main` 최신 — R12 051~054·057 병합 + 로컬 검증 전환 커밋. GitHub: https://github.com/kwakseongjae/tf-hwp (private)
- 갱신: 2026-07-11 · Claude(Fable 5) — CI→로컬 검증 전환(fmt 전체 정리·clippy 0·deny 그린·verify-local.sh 신설)

## 지금 (현재 위치)
- 로드맵 기준: **R12 배치 B 완료** — 053(셀 캐럿, dbcc1bd)·054(lift F2, 8cd4233)·057(표 앵커링, 8a28ce5)
  전부 병합. 캐럿 해상률 실클릭 공간 0%→100/99.8/100%(CARET-GAP §7), 무편집 .hwp 왕복 페이지 보존,
  표 편집 제자리 저장. R12 잔여 = **055(웹 하드닝)** 하나.
- 로드맵 정본: `docs/PRODUCT-DIRECTION-V2.md`(북극성 = 브라우저 프로덕션: 업로드→바이브+수동 편집→PDF) + 진행표 `docs/issues/README.md`(상태 진실은 git log — 복원 스크립트가 대조).
- 제품 현 수준: 웹(`apps/hwp-lab`)에서 업로드→수동+챗 편집→PDF/HWPX export가 전부 클라이언트사이드로 동작. 판정 = "강한 내부 데모/프라이빗 베타, GA 아님"(격차 5개가 이슈 051~056).

## 다음 (즉시 착수 가능)
1. **055 웹 하드닝** — 워크트리 구현 중(워커화·번들·한도). verify-local --full 그린 보고 대기 → 병합.
2. **웹 QA(사용자)**: 로컬 `pnpm -C packages/editor-core build && pnpm -C packages/react build` →
   `cd apps/hwp-lab && npm run dev` → localhost:3000 (가이드 `apps/hwp-lab/QA.md`). 외부 URL QA는 **061**(Vercel prebuilt, 오늘 30분 최소경로).
3. **R13 후보 4종 + 056** — 알려진 한계 리서치 완료, 이슈 승격됨: 058 폰트 / 059 IME(입력캡처) /
   060 프레임표 / 061 배포 / 056 crypto(착수가능). 착수 순서는 아키텍트 판단.
- 검증 정본: `scripts/verify-local.sh` (--full 포함). CI는 수동 전용(`gh workflow run ci`).

## 막힘 / 대기 (없으면 "없음")
- 없음. (056 배포용 crypto는 "수요 확인" 게이트 — 미착수가 정상 상태)

## 진행 중 레인 (병렬 작업 시에만)
| 레인/ID | owner | 상태 | 다음 체크포인트 |
|---|---|---|---|
| (없음 — 055 병합으로 R12 전 항목 완료) | | | |
