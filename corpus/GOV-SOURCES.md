# 공공문서 벤치 출처 매니페스트 (KOGL 실측 검증분)

실물 공공 HWPX 벤치 문서의 **출처 목록**이다. 바이너리는 레포에 커밋하지 않는다 — korea.kr 정책상
자유이용이 "텍스트에 한하여"이고 첨부 내 사진·이미지는 저작권자 별도 허락 대상이라(전 건 임베드
이미지 3~11개 실측), 재배포 대신 **원 출처에서 직접 내려받는 재현 방식**을 쓴다. 아래 sha256으로
동일 파일임을 검증할 수 있다(2026-07-22 기준 — 게시물 삭제/교체 시 어긋날 수 있음).

각 게시물 페이지에서 KOGL 마크를 실측 확인했다(0유형=자유이용 무조건 · 1유형=출처표시).

| 파일 | 발행처 | KOGL | 출처 | sha256 |
|---|---|---|---|---|
| korea-kr-moel__260331_보도참고_2026년_제1차_추경예산안_주요내용.hwpx | 고용노동부(정책브리핑) | KOGL-1(확인) | https://www.korea.kr/common/download.do?fileId=198406157&tblKey=GMN | `1e4785355e7af5e4…` |
| korea-kr-mpva__260413_보도자료_2026년_국외_보훈사적지_답사_참가자_모집.hwpx | 국가보훈부(정책브리핑) | KOGL-1(확인) | https://www.korea.kr/common/download.do?fileId=198421990&tblKey=GMN | `93f63161ba3d8602…` |
| korea-kr-mcst__0326_광화문_현판_토론회_개최.hwpx | 문화체육관광부(정책브리핑) | KOGL-0(확인) | https://www.korea.kr/common/download.do?fileId=198399778&tblKey=GMN | `6d3356866c25c43e…` |
| korea-kr-mcst__0411_문체부_2026년_1회_추경_확정.hwpx | 문화체육관광부(정책브리핑) | KOGL-0(확인) | https://www.korea.kr/common/download.do?fileId=198421223&tblKey=GMN | `05028f7210c55724…` |
| korea-kr-mcst__0212_개선이_필요한_공공언어_30선_발표.hwpx | 문화체육관광부(정책브리핑) | KOGL-1(확인) | https://www.korea.kr/common/download.do?fileId=198358317&tblKey=GMN | `f7ff611ee9d3ad9a…` |
| korea-kr-mcst__0413_사회문화시설_활용_인문_프로그램_공모.hwpx | 문화체육관광부(정책브리핑) | KOGL-0(확인) | https://www.korea.kr/common/download.do?fileId=198422462&tblKey=GMN | `338a76aa6700a769…` |
| mohw__보도참고_도수치료_관리급여_전환_3종_고시개정안_행정예고.hwpx | 보건복지부 | KOGL-1(확인) | https://mohw.go.kr/boardDownload.es?bid=0027&list_no=1490937&seq=1 | `72fa704001c7a144…` |

다운로드 후 `corpus/private/bench-public/files/`에 두면 `scripts/bench-corpus.sh`가 집계한다.

출처표시 예(1유형 표준 서식): "본 저작물은 ○○부에서 2026년 작성하여 공공누리 제1유형으로 개방한
보도자료를 이용하였으며, 대한민국 정책브리핑(www.korea.kr)에서 무료로 내려받을 수 있습니다."
