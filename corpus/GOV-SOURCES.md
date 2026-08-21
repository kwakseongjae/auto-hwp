# 공공문서 벤치 출처 매니페스트 (KOGL 실측 검증분)

실물 공공 HWP/HWPX 벤치 문서의 **출처 목록**이다. 바이너리는 레포에 커밋하지 않는다 —
korea.kr 정책상 자유이용이 "텍스트에 한하여"이고 첨부 내 사진·이미지는 저작권자 별도 허락
대상이라(보도자료 건 임베드 이미지 3~11개 실측), 재배포 대신 **원 출처에서 직접 내려받는
재현 방식**을 쓴다. 기계 정본은 `corpus/gov-sources.json`(전체 sha256). 아래 표는 사람용.

재현: `node scripts/fetch-gov-corpus.mjs` → `corpus/private/bench-public/files/`
(gitignore). 게시물 삭제/교체 시 sha256이 어긋나면 스크립트가 실패한다.

각 게시물 페이지에서 KOGL 마크를 **실측 확인**했다(0유형=자유이용 무조건 · 1유형=출처표시).
확인 못 한 문서·제2~4유형은 넣지 않는다.

## 보도자료 (기존 7건, 2026-07-22 실측)

| 파일 | 발행처 | KOGL | 출처 페이지 | 다운로드 | sha256 |
|---|---|---|---|---|---|
| korea-kr-moel__260331_보도참고_2026년_제1차_추경예산안_주요내용.hwpx | 고용노동부(정책브리핑) | KOGL-1 | https://www.korea.kr/briefing/pressReleaseView.do?newsId=156752041 | https://www.korea.kr/common/download.do?fileId=198406157&tblKey=GMN | `1e4785355e7af5e4…` |
| korea-kr-mpva__260413_보도자료_2026년_국외_보훈사적지_답사_참가자_모집.hwpx | 국가보훈부(정책브리핑) | KOGL-1 | https://www.korea.kr/briefing/pressReleaseView.do?newsId=156754206 | https://www.korea.kr/common/download.do?fileId=198421990&tblKey=GMN | `93f63161ba3d8602…` |
| korea-kr-mcst__0326_광화문_현판_토론회_개최.hwpx | 문화체육관광부(정책브리핑) | KOGL-0 | https://www.korea.kr/briefing/pressReleaseView.do?newsId=156750968 | https://www.korea.kr/common/download.do?fileId=198399778&tblKey=GMN | `6d3356866c25c43e…` |
| korea-kr-mcst__0411_문체부_2026년_1회_추경_확정.hwpx | 문화체육관광부(정책브리핑) | KOGL-0 | https://www.korea.kr/briefing/pressReleaseView.do?newsId=156754077 | https://www.korea.kr/common/download.do?fileId=198421223&tblKey=GMN | `05028f7210c55724…` |
| korea-kr-mcst__0212_개선이_필요한_공공언어_30선_발표.hwpx | 문화체육관광부(정책브리핑) | KOGL-1 | https://www.korea.kr/briefing/pressReleaseView.do?newsId=156744367 | https://www.korea.kr/common/download.do?fileId=198358317&tblKey=GMN | `f7ff611ee9d3ad9a…` |
| korea-kr-mcst__0413_사회문화시설_활용_인문_프로그램_공모.hwpx | 문화체육관광부(정책브리핑) | KOGL-0 | https://www.korea.kr/briefing/pressReleaseView.do?newsId=156754121 | https://www.korea.kr/common/download.do?fileId=198422462&tblKey=GMN | `338a76aa6700a769…` |
| mohw__보도참고_도수치료_관리급여_전환_3종_고시개정안_행정예고.hwpx | 보건복지부 | KOGL-1 | https://mohw.go.kr/board.es?act=view&bid=0027&list_no=1490937&mid=a10503010100 | https://mohw.go.kr/boardDownload.es?bid=0027&list_no=1490937&seq=1 | `72fa704001c7a144…` |

## 양식·서식 (T1-R1, 2026-08-21 실측)

보도자료만 모이면 #42류 결함(폼 컨트롤·머리말 표·가로세로 혼합)이 사는 **양식**이 비는 편향이
생긴다. 아래는 공공누리 자료실 게시물에서 제1유형 문구를 **페이지에서 읽어** 확인한 서식이다.

실측 문구(두 게시물 공통): 「한국문화정보원이 제공한 본 저작물은 "공공누리" 제1유형:출처표시
조건에 따라 이용할 수 있습니다.」

| 파일 | 발행처 | KOGL | 출처 페이지 | 다운로드 | sha256 |
|---|---|---|---|---|---|
| kogl__붙임_개방지원_사업_신청서.hwp | 한국문화정보원(공공누리) | KOGL-1(2026-08-21) | https://www.kogl.or.kr/edu/eduDataView.do?dataIdx=58 | https://www.kogl.or.kr/edu/eduDataFileDown.do?dataIdx=58&dataFileIdx=2 | `42919e899498c59a…` |
| kogl__서식1_저작재산권_양도_계약서.hwp | 한국문화정보원(공공누리) | KOGL-1(2026-08-21) | https://www.kogl.or.kr/edu/eduDataView.do?dataIdx=131 | https://www.kogl.or.kr/edu/eduDataFileDown.do?dataIdx=131&dataFileIdx=1 | `65df1316e43bb455…` |
| kogl__서식2_공공저작물_자유이용_허락_동의서.hwp | 한국문화정보원(공공누리) | KOGL-1(2026-08-21) | https://www.kogl.or.kr/edu/eduDataView.do?dataIdx=131 | https://www.kogl.or.kr/edu/eduDataFileDown.do?dataIdx=131&dataFileIdx=2 | `5b4213ac34b91523…` |
| kogl__서식3_초상이용_동의서.hwp | 한국문화정보원(공공누리) | KOGL-1(2026-08-21) | https://www.kogl.or.kr/edu/eduDataView.do?dataIdx=131 | https://www.kogl.or.kr/edu/eduDataFileDown.do?dataIdx=131&dataFileIdx=3 | `e39ba20523a12172…` |

출처표시 예(1유형 표준 서식): "본 저작물은 ○○에서 ○○년 작성하여 공공누리 제1유형으로 개방한
자료를 이용하였으며, 해당 게시물 페이지에서 무료로 내려받을 수 있습니다."
