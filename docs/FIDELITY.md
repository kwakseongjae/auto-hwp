# Fidelity 검증 — benchmark 중심 "원본 그대로" 게이트

북극성은 *원본 그대로*다. 이를 측정 가능한 게이트로 만든다: 우리 엔진 렌더를 **오라클**(LibreOffice + H2Orestart) 렌더와 페이지별로 비교한다. 기준 문서는 루트의 `benchmark.hwp`(사용자 제공, HWP5)이며 `corpus/`의 골든 샘플로 확장한다.

> 정합성은 "한컴과 픽셀 동일"이 아니라 **"우리 골든 대비 회귀 없음 + 허용오차 내 구조 일치"** 로 게이트한다(한컴 출력조차 환경 의존적이라 절대 정답지가 아님 — PLAN §6).

## 구성 요소
- `crates/hwp-fidelity` — 하베스. `benchmark_path()`, `Prerequisites::detect()`, `reference_pdf()`, `compare()`(grayscale-MAE 스코어러), `FidelityBand{Green,Yellow,Red}`, `ReferenceKind{GroundTruthPdf,Oracle}`, **known-divergence allowlist**(`benchmark_allowlist()`, `unexpected_divergences()`).
- `crates/hwp-oracle` — `soffice_available()`, `h2orestart_installed()`, `convert_to_pdf()`.
- 테스트: `crates/hwp-fidelity/tests/benchmark.rs`
  - `benchmark_present_and_hwp5` — CI 실행(포맷 게이트). **fixture가 없으면 graceful skip**(사용자 제공 문서가 없는 CI도 그린 유지).
  - `benchmark_engine_has_no_unexpected_divergence` — `#[ignore]`, 엔진 렌더(`--features rhwp`) + 레퍼런스(ground-truth PDF 또는 H2Orestart 오라클) 필요. **allowlist 적용 후 unexpected divergence 0** 단언. ground-truth가 있으면 **페이지 수 정확 일치 + 전 페이지 Red 0**(절대 fidelity).
  - allowlist/divergence **로직 자체는 `src/lib.rs`의 유닛테스트로 전제조건 없이 CI 실행** → fidelity 계약이 렌더 불가 머신에서도 강제됨.

## known-divergence allowlist (회귀 게이트의 핵심)
게이트는 *알려진* 구조적 차이만 명시적으로 면제하고, 새/미등재 발산은 전부 실패시킨다.
- `benchmark_allowlist()`: 루트 `benchmark.hwp`의 면제 목록. **ground-truth Hancom PDF 대비로는 면제 0개**(8p 전부 일치). 유일한 엔트리는 약한 교차렌더(Oracle) 모드에서 LibreOffice의 재페이지네이션(8 vs 10)만 면제 — **페이지 *내용*은 여전히 페이지별로 게이트**.
- `unexpected_divergences(report, allow)`: allowlist로 덮이지 않는 Red 페이지/페이지수 불일치 목록. 게이트는 이게 비어야 통과. 정렬-범위 내 content Red는 절대 면제 안 됨.
- 새 발산을 면제하려면 **이유와 함께** allowlist에 엔트리를 추가한다(코드 리뷰 대상).

## 상태 확인
```bash
cargo run -p tf-hwp-cli -- fidelity            # benchmark.hwp 전제조건/상태
cargo run -p tf-hwp-cli -- fidelity <file>     # 임의 파일
cargo test -p hwp-fidelity                      # 지금 실행되는 게이트
cargo test -p hwp-fidelity -- --ignored         # 전제조건 충족 시 전체
```

## 전제조건 활성화 (이 머신에서 완료됨)
게이트는 전제조건을 감지해 충족분만 실행한다(계산 못 하는 통과를 주장하지 않음).
1. **오라클(레퍼런스 렌더)** — 현대 HWP는 LibreOffice 네이티브 hwpfilter로 안 열린다(v3 전용). **H2Orestart 확장 + JDK** 필요(H2Orestart는 Java 확장).
   - JDK: `brew install openjdk` + `sudo ln -sfn /opt/homebrew/opt/openjdk/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk.jdk` (macOS는 여기만 스캔).
   - H2Orestart: **LibreOffice GUI → 도구 → 확장 관리자 → 추가**로 `~/Downloads/H2Orestart.oxt` 설치(CLI `unopkg add`는 이 환경의 프로세스 제약으로 파이프 에러 → GUI로 우회). `scripts/install-h2orestart.sh`는 다운로드용.
2. **엔진 렌더(ours)** — rhwp 부트스트랩:
   ```bash
   cargo run -p tf-hwp-cli --features rhwp -- fidelity     # 교차렌더 compare 실행
   cargo test -p hwp-fidelity --features rhwp -- --ignored # benchmark_oracle_and_fidelity
   ```

## ⚠️ "교차렌더 일치도" ≠ 절대 fidelity (→ ground-truth로 해소됨)
스코어러는 레퍼런스를 자동 선택한다(`ReferenceKind`): 입력 옆에 `<stem>.pdf`(한컴 생성 정답지)가 있으면 **GroundTruthPdf = 절대 fidelity**(soffice/H2Orestart 불필요, 엔진 렌더만 필요), 없으면 **Oracle = 교차렌더 일치도**(LibreOffice+H2Orestart, 둘 다 한컴 정답지가 아님 — 대체폰트·AA·페이지네이션 상이).
- **현재 상태(해소됨): `benchmark.pdf`(한컴 생성, 8p) 정답지 대비 page 1–8 전부 GREEN(94.9–99.2%), 페이지수 8 vs 8 정확 일치 → overall GREEN, 게이트 통과.** 과거의 "page 9–10 RED"는 오라클(LibreOffice 10p 재페이지네이션) 모드의 신호였고, 지금은 allowlist로 면제되며 ground-truth 모드에선 발생하지 않는다.

## 밴드 정책 (UX 게이트로 직결)
- **Green** — 허용오차 내 일치 → 인라인 편집.
- **Yellow** — 근접하나 플래그 → "근사 레이아웃" 배너로 편집.
- **Red** — 발산 → 읽기전용 PDF 폴백. *프로덕션 게이트: benchmark 페이지 Red 0.*

## 마일스톤별 게이트
ROADMAP §3 표 참조. 요약: M1 = 페이지 Red 0, M2 = 한국어 타이포(자간/장평/배분·나눔/금칙/줄간격) 임계치, M4 = 편집→.hwpx round-trip 무손실, M6 = 편집→.hwp 실제 한글 오픈.

## 케이스 추가
1. 문서를 `corpus/`(공개 가능) 또는 `corpus/private/`(gitignore)에 둔다.
2. (선택) 한컴/오라클 레퍼런스 PDF를 같이 둔다.
3. 하베스가 코퍼스를 순회하며 페이지 점수를 산출한다(스코어러는 M1에서 일반화).
