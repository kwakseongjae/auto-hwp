# 002 — 사용자정의 탭 정지 + 개요/번호 형식 문자열

- 상태: **open**
- 우선순위: P3 (폴리시)
- 영역: 문단모양 / 목록 (로드맵 P8)

## 문제
- **탭 정지(Tab stops)**: `<hh:tabProperties>` 풀에 사용자정의 탭(종류 LEFT/RIGHT/CENTER/DECIMAL, 위치, 채움 문자)을 합성하고 paraPr `tabPrIDRef`로 연결. 현재는 기본 탭만.
- **번호 형식 문자열**: 개요/문단 번호의 사용자 정의 형식(`^1.^2)`, "제 N 조" 등). 001(네이티브 목록)에 종속.

## 왜 보류했나
- 공문서 핵심 서식(글자/문단/표/정렬/들여쓰기)에 비해 사용 빈도 낮음.
- 탭 값도 `hp:switch` **doubling** 대상(`hp:case` pos = V, `hp:default` pos = 2V) — paraPr 여백과 동일 패턴, 합성 시 주의.

## 접근(구현 시)
1. `TabInterner`(synth.rs): `<hh:tabPr>` 합성 + itemCnt, paraPr `tabPrIDRef` 갱신.
2. `tabItem` per-stop: `<hp:switch>` case/default 두 벌(pos doubling).
3. `ParaSpec`에 `tabs: Vec<TabStop{kind,pos_pt,fill}>` 추가, AiPara 노출.

## 수용 기준
- 우측/소수점 탭이 한컴/오라클에서 정렬되어 렌더.
