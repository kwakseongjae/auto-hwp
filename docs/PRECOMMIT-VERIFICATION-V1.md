# Pre-commit Verification Report v1

AI 편집은 `ProposalV1`의 비공개 scratch 문서를 실제 커밋 전에 자체 엔진으로 검증한다. 보고서는
원문·SVG·PDF 바이트를 노출하지 않고 안정 해시, 개수, 모델 주소, 기계 판정 코드만 반환한다.

## 판정 순서

1. 라이브/preview 의미 트리를 블록 주소별로 비교한다. 선언된 영향 범위 밖의 변경은
   `declared-unaffected-semantic-change`로 커밋을 차단한다.
2. 두 문서를 동일 폰트 provider로 `place_doc`와 `NaiveLayout`에 각각 통과시킨다. 페이지 수가
   다르면 `layout-lockstep-mismatch`로 차단한다.
3. 영향 페이지의 before/after 자체 렌더 SVG를 만들고 해시와 바이트 수만 기록한다. SVG 차이는
   사람이 살펴볼 advisory이지 구조 검사를 뒤집는 점수가 아니다.
4. `pdf` 빌드에서는 동일 IR로 before/after PDF를 만들고 해시·쪽수·객체 replay/stub 수·진단
   코드만 기록한다. 제안이 placeholder/stub을 새로 늘리면 커밋을 차단한다.

`commit_allowed`는 구조 안전성 판정이다. `submission_ready`는 더 엄격하며, 원문에 이미 있던
placeholder/stub도 0이어야 한다. 따라서 기존 미지원 객체가 있는 문서의 무관한 안전 편집은 가능하지만
그 결과를 제출 준비 완료라고 주장하지 않는다.

## 영향 범위

단일 블록·셀 편집은 해당 주소를 선언한다. 삽입·삭제·이동처럼 인덱스를 바꾸는 편집은 해당 섹션
전체를, `ApplyContent`·`ApplyEditScript`·전역 Replace는 문서 전체를 보수적으로 선언한다. before와
after에서 계산한 영향 페이지의 합집합을 사용하므로 재조판으로 새로 생기거나 사라진 페이지도 증거에서
누락되지 않는다.

## 비권한성

FNV-1a 해시는 셸 간 결정성 및 증거 식별용이지 보안 서명이나 커밋 권한이 아니다. 실제 권한은 엔진이
보관한 pending snapshot과 session/document/revision 바인딩이다. 조판 기준선(8/18/24, 98.9%+, 오라클
82)은 PR의 기존 gate에서 별도로 고정되며 보고서 수치로 완화할 수 없다.
