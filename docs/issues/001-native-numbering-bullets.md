# 001 — 네이티브 자동번호/글머리표 풀 (`hh:numbering` / `hh:bullet`)

- 상태: **open**
- 우선순위: P2
- 영역: AI 콘텐츠 템플릿 / HWPX 합성 (로드맵 P6)

## 문제
현재 `bullet_list`/`ordered_list`는 **행잉 인덴트 문단 + 마커 텍스트("• ", "1. ")** 로 렌더한다(안정적, 오라클 검증됨). 그러나 한컴의 *진짜* 자동 번호/글머리표(번호 다시 시작, 수준별 번호 형식, 항목 추가 시 자동 재번호)는 아니다.

진짜 네이티브 목록은:
- `<hh:numberings>` / `<hh:bullets>` 풀에 항목 정의를 합성하고,
- 문단 `<hh:paraPr>`의 `<hh:heading type="NUMBER|BULLET" idRef level>`로 연결.

## 왜 보류했나 (load-bearing)
- **코퍼스 근거 0**: 보유 corpus(FormattingShowcase/Skeleton/00_smoke_min)에 `hh:bullets`가 전혀 없고, 본문이 `NUMBER`/`BULLET` heading을 참조하는 예도 없다 → clone-and-patch 베이스가 없다.
- **오라클 검증 불가**: 자동 마커 글리프/번호는 렌더러가 레이아웃 시 생성 → LibreOffice+H2Orestart가 우리 합성 풀을 정확히 해석하는지 PDF로 확인하기 어렵다. 로드맵이 HIGH RISK로 표시.
- `linesegarray` 생략이 목록 마커에서 더 위험(마커 자리 계산).

## 접근(구현 시)
1. `python-hwpx`(airmang, Apache-2.0) 소스에서 `numbering`/`bullet` 방출 패턴을 정확히 추출.
2. 외부 실제 .hwpx 샘플(자동번호 포함)을 1개 이상 확보해 ground-truth 코퍼스에 추가.
3. `NumberingInterner`/`BulletInterner`(synth.rs) — 풀 합성 + itemCnt, `paraPr heading` 연결.
4. `Op::AppendOrderedList`/`AppendBulletList`/`AppendMultiLevelList` + AiBlock 확장.
5. **검증**: 실제 한컴에서 자동 번호가 매겨지는지 사용자 확인(오라클만으로 불충분).

## 수용 기준
- 다수준 번호(1. / 가. / 1)) 매겨지고, 항목 추가 시 자동 재번호.
- 한컴/오라클 모두 정상 오픈, 원본 보존.
