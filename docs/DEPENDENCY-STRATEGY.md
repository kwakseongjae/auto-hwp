# 의존성 & Build-vs-Own 전략

> 핵심 원칙: **rhwp는 "우리가 소유한 trait 뒤에 꽂힌 교체 가능한 부트스트랩"이지, 천장이 아니다.**
> 최종 국면은 *이전에 없던 것* — 충실 렌더 + 편집 + 안전한 HWPX round-trip + AI 작성이 한 크로스플랫폼 엔진에 들어간 형태 — 이므로, rhwp가 제공하지 않거나 한컴 비호환인 부분은 **우리가 직접 구현**한다. rhwp 의존은 시간이 지나며 0에 수렴하는 것이 목표.

---

## 1. 능력(Capability) 경계 = trait

모든 외부 능력은 `hwp-model`이 정의하는 trait 뒤에 둔다. UI/AI/CLI는 trait만 본다. 구현체는 갈아끼운다.

| Capability (trait) | 의미 | 부트스트랩 구현 | 자체 구현 목표 |
|---|---|---|---|
| `DocumentParser` | bytes → SemanticDoc | `hwp-rhwp`(HWP5/HWP3/HWPX), `hwp-hwpx`(HWPX) | `hwp-hwpx` 완전 OWPML 파서 + 자체 HWP5 파서 |
| `LayoutEngine` | doc → line segs/pagination | rhwp typeset | `hwp-typeset`(자간/장평/배분·나눔/금칙/줄간격 4모드) |
| `Renderer` | layout → PageLayerTree(paint IR) | rhwp `getPageLayerTree` | `hwp-render` 자체 paint |
| `HwpxSerializer` | doc → .hwpx (dirty-only) | **없음**(rhwp 직렬화기는 한컴 비호환) | **`hwp-hwpx` 자체 — 처음부터 우리 것** |
| `FontMetricsProvider` | 글리프 advance | rhwp host Canvas `measureText` | harfrust/rustybuzz 셰이핑 기반 |

→ `hwp-core::Engine`이 "능력별로 가용한 최선의 구현"을 조립한다. rhwp가 없으면 자체/degraded 구현으로 폴백하되 **워크스페이스는 항상 green으로 컴파일·동작**한다.

---

## 2. 교체 사다리(Replaceability Ladder)

rhwp 의존을 줄이는 순서. 각 단계는 독립적으로 진행 가능.

1. **HwpxSerializer (지금부터 우리 것)** — rhwp 직렬화기 사용 금지(issue #196: 한컴 손상 판정). PR#40 3종 계약 + dirty-only를 자체 구현. *가장 먼저 rhwp 비의존.*
2. **HWPX DocumentParser** — `hwp-hwpx` OWPML 파서를 키워 HWPX 입력을 rhwp 없이 처리. (HWP5는 한동안 rhwp 부트스트랩 유지)
3. **LayoutEngine / FontMetricsProvider** — `hwp-typeset` + harfrust 셰이퍼로 한컴급 한국어 조판을 자체화(rhwp의 host-Canvas 메트릭·미구현 micro-typo 대체).
4. **Renderer** — 자체 paint 백엔드.
5. **HWP5 DocumentParser** — 자체 바이너리 파서(최후순위; rhwp가 가장 잘하는 영역).

---

## 3. 의존성 분류 정책

| 분류 | 정책 | 예 |
|---|---|---|
| **OWN (자체 구현 필수)** | 신규성/차별점이거나 좋은 옵션이 없음 → 우리가 만든다 | HWPX 직렬화기·round-trip 안전 커널, op-bus, AI projection/MCP, 한국어 정렬(배분/나눔)·자간·장평, 옛한글 PUA→첫가끝 테이블 |
| **VENDOR-REPLACE (지금 빌리고 나중에 교체)** | trait 뒤 부트스트랩, 사다리대로 제거 | **rhwp** (벤더 포크, submodule) |
| **BORROW-STABLE (안정 의존 유지)** | 순수 Rust·wasm-ok·잘 유지되는 라이브러리는 재발명 안 함 | `quick-xml`, `zip`/`flate2`(miniz_oxide), `harfrust`/`rustybuzz`, `icu_segmenter`, `unicode-normalization`, `cfb`, `clap` |
| **ORACLE-ONLY (프로세스 격리)** | 링크 금지, 검증/폴백 전용 | LibreOffice + H2Orestart (GPL) |
| **FORBIDDEN** | 라이선스/이식성 | AGPL(pyhwp), 한컴 COM/SDK(상용·Windows) |

### "직접 만든다"의 판단 기준
다음 중 하나면 자체 구현으로 결정:
1. **rhwp가 막는다** — 미구현/부정확/한컴 비호환 (예: HWPX 직렬화기, micro-typography 일부).
2. **신규성** — 최종 목표가 아무도 제공하지 않는 능력(안전한 HWPX 라운드트립 writer, AST 레벨 AI 편집, 한국어 정렬 충실도).
3. **재현성/제어** — 결정적 결과가 필요(폰트 메트릭, native==wasm 줄바꿈 동일성).
4. **라이선스** — 코어에 GPL/AGPL 불가.

그 외(순수 Rust·wasm-ok·잘 유지되는 범용 라이브러리)는 **BORROW-STABLE** — 재발명하지 않는다(셰이핑/ZIP/XML/세그멘테이션 등).

---

## 4. 우리만의 신규 가치 (최종 국면 = 이전에 없던 것)
1. **충실 렌더 + 편집 + 안전한 HWPX export가 하나의 크로스플랫폼 엔진** — rhwp 직렬화기는 한컴 비호환, python-hwpx는 Python·렌더 없음, hwplib은 JVM·렌더 없음. *셋을 동시에* 가진 건 없다.
2. **AST 레벨 AI 저작 + round-trip 안전 + MCP** — PDF-flatten·COM-Windows 우회가 아닌, 검증되는 typed op로 문서를 편집.
3. **깨끗한 엔진 경계 뒤의 한컴급 한국어 조판** — 배분/나눔 정렬·자간·장평·금칙을 교체 가능한 모듈로.

---

## 5. wasm 위생
- 코어 순수 크레이트(`hwp-model`, `hwp-ops`, `hwp-ingest`)는 **wasm32-unknown-unknown 컴파일을 CI에서 강제**(BORROW-STABLE 의존도 wasm-ok만).
- C 의존(native-skia 등)·`std::process`(oracle)는 native 전용 크레이트에 격리, wasm feature에서 제외.
- 셰이핑/레이아웃은 공유 Rust → native와 wasm이 동일 줄바꿈(골든 테스트·한컴 수용 게이트 전제).
