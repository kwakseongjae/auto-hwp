# auto-hwp 제품 방향 v3 — HWPX 정본 · 벌크 엔진 · 레시피 생태계 · 데스크톱 나중

> 작성: 2026-08-14. 공개 이슈 **#38**.
> v1(`docs/PRODUCT-DIRECTION.md`)의 **§4 빌더 공통 계약은 그대로 유효**하다. v2는 R12
> 브라우저 프로덕션 격차표(대부분 완료)로 남긴다. 상태 포인터는 `docs/CURRENT_STATE.md`.
>
> 외부 사실의 근거는 Grok `/deep-research` 런 `deep-research`(14m03s, **Partial**,
> 워크플로 리포트 + 검증 저널 24/24 supported). KS 본문·온나라 기술공고·일부 부속 PDF는
> 열지 못했다. 레포 상태는 이슈 **헤더** + CURRENT_STATE가 정본이고,
> `docs/issues/README.md` 표·`AGENT-FUNNEL` §0는 여러 칸이 스테일이다.

---

## 1. 북극성

**한글 양식을 한컴 없이 데이터로 만들고, 그 과정을 사람·에이전트가 같은 계약으로 재사용하게 한다.**

운영 정의:

1. **쓰기 정본은 HWPX.** 바이너리 `.hwp`는 열고, 텍스트 레인은 원본 패치로 되돌릴 수 있으나
   전체 재직렬화는 하지 않는다.
2. **일괄 생성(양식 × 명단 → N부)이 엔진 계약**이다. `/bulk`는 그 계약의 첫 셸이다.
3. **남이 기능을 만들 수 있게** Intent · FillMap · MCP · npm을 깨지 않는다.
4. **데스크톱은 같은 엔진의 OS 셸**이며, HOP식 「설치해서 한글처럼」을 복제하지 않는다.

산 제품(2026-08-13 CURRENT_STATE): https://autohwp.com 공개 베타, npm `@auto-hwp/*` 0.0.5,
`/bulk`, MCP/CLI/Docker. 한컴 인증 아님. `.hwp` 공개 저장 아님.

---

## 2. 검증된 바깥 세계 (Partial)

### 2.1 포맷

| 사실 | 출처 |
|---|---|
| KS X 6101 = OWPML 문서 구조. 제정 2011-12-30, 최종개정 2024-10-30 | [e-나라표준인증 KS X 6101](https://standard.go.kr/KSCI/standardIntro/getStandardSearchView.do?ksNo=KSX6101) |
| 적용범위: XML로 바이너리 HWP를 「100% 호환」 기술. 명칭 OWPML(HWPX) | [KSSN](https://www.kssn.net/search/stddetail.do?itemNo=K001010149626) |
| `.hwp` = CFB/OLE 레코드. `.hwpx` = ZIP+XML | [한컴 5.0 r1.3](https://cdn.hancom.com/link/docs/한글문서파일형식_5.0_revision1.3.pdf), [한컴테크 HWPX](https://tech.hancom.com/hwpxformat/) |
| HWP↔HWPX 자동 변환 없음. HWP는 계속 제공 | [한컴 FAQ 2784](https://www.hancom.com/support/faqCenter/faq/detail/2784) |
| 한컴 기본 저장 HWPX 패치: 2021-04-15 | 한컴그룹 보도(딥리서치 S6) |

**Partial:** KS 410쪽 본문 미개봉. FAQ 3131의 2015-07-18 vs 카탈로그 2015-07-28 불일치.

### 2.2 공공 의무 — 「법령이 HWPX만 허용」은 과장

- [대통령령 제36333호](https://www.law.go.kr/LSW/lsInfoP.do?lsId=003728&ancYnChk=0) 시행 **2026-05-19**.
  「개방형 문서 형식」= 규격 공개 + 공공데이터법 기계판독. **HWPX라는 단어 없음.**
- 같은 정의는 [제33575호](https://www.law.go.kr/LSW/lsRvsRsnListP.do?lsId=003728&chrClsCd=010102) **2023-06-27**에 이미 신설.
- [행안부 2026-05-12](https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=125938):
  **5월 18일**부터 중앙·지방 온나라에 개방형 문서만 첨부. 여기도 HWPX 고유명사 없음.
- [국가AI전략위 2026-04-24](https://www.aikorea.go.kr/web/board/brdDetail.do?menu_cd=000012&num=562):
  중앙 온나라 **2022 HWPX**, 지방 **2026-05-18**, 온메일/공직자메일 **2026-10** hwp 첨부 제한.

**Partial:** 2022 행안부 HTML은 HWPX/날짜를 안 씀. 18일(운영) vs 19일(령) 하루 차.
온나라 기술공고 미개봉. 현장의 「`.hwp`로 돌려달라」는 073 실측이지 이번 법령 검증이 아니다.

### 2.3 경쟁 한 줄

한컴 없는 쓰기는 **HWPX에 몰려 있다.** `.hwp` writer 후보는 hwplib(쪽수/PDF 불가),
kordoc `patchHwp`, claw-hwp(릴리스 0), HOP의 HWP 저장(HWPX 저장은 DEVELOPMENT.md에서 차단).
전용 메일머지 제품은 없다. python-hwpx + `hwpx-mcp-server`가 HWPX MCP 쪽 직접 경쟁.
**HOP**가 「데스크톱에서 연다」를 가져갔다. 오픈한글AI는 브라우저 HWPX 에디터(HWP는 열기만).

품질(한컴이 그 바이트를 여는가)은 이번 런에서 **실측하지 않았다.**

---

## 3. 레포가 이미 가진 것 /  interlock

하지 말 것(적대 검수):

- 056·067을 다음 구현 티켓으로 열기 (헤더 done / `87834a2` main).
- 「082가 없어서 F3를 처음부터」 (`hwp-hwp5-patch`는 main, 공개만 제외).
- 044를 「기본 셸이 안 바뀌어서 미완」으로 재오픈 (기본 off가 계약).
- 061을 「웹 배포」로 재오픈 (autohwp.com 라이브).

진짜 빈칸(이슈 파일 없음): F2 `share_review`/`poll_review`, 누름틀 fill op,
044 default-on(§4.8 QA 후 **신규**), 셀 안 도장.

---

## 4. 네 축과 착수 순서

불변식(게이트 8==8·18==18, LOCKSTEP, rhwp 파싱 전용, Intent additive, 단위)은 v1 §4.

```
0. 스테일 문서 + 082 한컴 게이트 결정
    ↓
A. 기관 양식이 왕복하고 한컴이 연다
    ↓
B. FillMap × Roster → N부가 엔진 API
    ↓
C. 남이 레시피를 만든다 (Intent / FillMap / MCP)
    ↓
D. 같은 엔진의 얇은 데스크톱 (HOP 복제 금지)
```

| 구간 | 목표 | 이슈 | 하지 말 것 |
|---|---|---|---|
| **0** | 거짓 이중기획 차단 | 본 이슈(#38) 문서. 082 수동 게이트는 기존 082 | 056/067 재구현 |
| **A 0–3개월** | 한컴이 여는 저장 | **082** 수동. capability UI. **075** 오라클. **078** 차트. **081** 중첩 캐럿. **005**는 양식에 다단이 있을 때만 | KS 100% / HWP5 전체 재직렬화 / rhwp exportHwp |
| **B 3–8개월** | 벌크가 엔진 | **073** xlsx·spec CLI·검수 프리뷰. 누름틀 **신설**. `.hwp` 텍스트 산출은 082 공개 후. **079** P2 | 「우리가 유일한 벌크」서사 |
| **C 8–14개월** | 레시피 생태계 | FillMap 공개 계약. F2 **신설**. npm 예제 | rhwp·HOP·기안기 정면승부 |
| **D 14개월+** | OS 셸 | 044 §4.8 QA → **신규** default-on. 파일연결·인쇄·로컬 MCP | 「맥에서 한글 대신」 |

편집 품질(076 문단횡단, 081)과 런칭 잔여(083, 085 증거)는 A–D와 **별 트랙**이다. 네 축으로 접지 마라.

---

## 5. 다음 코딩 한 줄

**082를 한/글 또는 한컴독스에서 열어보거나, 공개 제외를 명시적으로 유지한다.**

병렬로 안전한 것: 073 xlsx, F2 이슈 신설, 본 문서 착륙 후 누름틀 이슈 신설.

---

## 6. 이번 조사의 남은 구멍

- KS 본문, 온나라 설정/기술공고, 2022 첨부 PDF 미개봉.
- `hwpxlib`, python-hwpx-automation `[hwp]` extra 미개봉.
- hwplib/kordoc/claw-hwp 산출물을 한컴이 여는지는 미실측.
- 양식에서 누름틀·도장·차트·다단 **빈도** 미계측 → B/A 세부 우선순위는 가설.
- npm registry 실시간 조회는 하지 않음(레포 핀 0.0.5 + 2026-08-13 증거 파일).
