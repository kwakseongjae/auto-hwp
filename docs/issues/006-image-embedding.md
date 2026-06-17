# 006 — 이미지 임베드 (BinData + manifest + `hp:pic`)

- 상태: **long-term** (코퍼스 근거 없음 → 검증 불가)
- 우선순위: P2
- 영역: HWPX 합성 / 복잡 시나리오

## 문제
AI/사용자가 문서에 래스터 이미지(로고, 차트 캡처 등)를 삽입하는 기능. OWPML에서:
- 이미지 바이트를 `BinData/`(또는 `Contents`) 파트로 ZIP에 추가,
- `META-INF/manifest.xml` + `Contents/content.hpf`에 파트 등록,
- 본문에 `<hp:pic>`/`<hc:img binDataIDRef=..>` + 크기/위치(`hp:sz`/`hp:pos`) 방출.

## 왜 long-term인가
- **보유 코퍼스(FormattingShowcase/Skeleton/00_smoke_min)에 임베드 이미지가 0개** → clone-and-patch 베이스가 없음(글자/문단/표/페이지처럼 기존 요소 복제가 불가).
- manifest/content.hpf 동시 갱신 + 새 ZIP 파트 + pic XML이 동시에 맞아야 하고, 오라클이 우리 합성을 정확히 해석하는지 확인하려면 실제 한컴 검수 필요.
- 검증 경로가 약함(이미지 렌더는 폰트 substitution처럼 환경 의존).

## 접근(구현 시)
1. 실제 한컴이 만든, 이미지 포함 .hwpx 샘플 1개 이상 확보 → ground-truth 코퍼스에 추가.
2. python-hwpx의 이미지 삽입 경로 정밀 추출(manifest/content.hpf/pic 방출 순서).
3. `Op::InsertImage`(이미 enum에 선언됨) apply + serializer가 BinData 파트 추가 + manifest/hpf 패치 + `<hp:pic>` 방출.
4. AiBlock `image`(path/width/height) + 검증(실제 한컴에서 이미지 표시 확인).

## 수용 기준
- PNG/JPG가 한컴/오라클에서 올바른 크기·위치로 표시, 원본 보존, round-trip 안전.
