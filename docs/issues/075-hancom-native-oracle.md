# 075 — 한컴 네이티브 오라클 레인

- 상태: **research-complete / implementation-open** (2026-07-28)
- 우선순위: **P0 (충실도 판정 인프라)**
- 목표: LibreOffice·변환 PDF를 정답으로 오인하지 않고, 한컴 엔진의 쪽수와 페이지 이미지를 재현 가능한
  릴리스 증거로 남긴다.

## 왜 필요한가

074에서 `landscape="NARROWLY"`를 외부 변환기가 반대로 해석해 같은 파일의 오라클이 17↔25쪽으로
뒤집혔다. 따라서 “다른 뷰어가 열었다”는 사실만으로 한컴 조판의 정답이 되지 않는다.

공식 채널 조사 결과:

- [한컴 오토메이션](https://developer.hancom.com/hwpautomation)은 Windows OLE/COM 자동화를 제공한다.
  비상업 개인 이용과 상업 이용의 라이선스 조건이 다르고, 로컬 파일 접근에는 공식 보안 모듈 등록이 필요하다.
- [WebHWP](https://developer.hancom.com/webhwp/overview)는 브라우저 클라이언트용 제품이지만 웹 서버와
  필터 서버를 직접 운영하는 상용 제품이다. 공개 SaaS 변환 API로 간주하면 안 된다.
- WebHWP에는 전체 조판을 수행하는 읽기 전용
  [`PageCount`](https://developer.hancom.com/webhwp/devguide/hwpctrl/properties/pagecount)와 페이지별
  [`CreatePageImage`](https://developer.hancom.com/webhwp/devguide/hwpctrl/methods/createpageimage)가 있어,
  제품 도입 시 오라클 구현에는 가장 깔끔하다.

## 결정

1. **즉시 경로**: 라이선스된 한글이 설치된 사설 Windows VM에서 OLE/COM을 돌리는 nightly/release lane.
2. **장기 경로**: WebHWP Server를 실제로 구매·운영하게 될 때 동일 manifest 계약으로 백엔드만 교체.
3. 수동 QA는 오라클 부재 시 임시 증거이지 자동 게이트를 대체하지 않는다.
4. 개인/비공개 문서는 사설 runner 밖으로 보내지 않는다.

## 출력 계약

각 입력마다 다음 manifest를 만든다.

- 입력 SHA-256, 한글 제품/빌드, OS, 설치 글꼴 지문
- 문서 방향과 각 페이지 크기(가로/세로를 수치로 기록)
- 전체 쪽수
- 페이지별 PNG와 SHA-256(후속으로 pHash/SSIM 추가)
- 실행 로그와 실패 원인(암호/배포용/누락 글꼴/복구 대화상자)

## 수용 기준

- [ ] 사설 Windows runner에서 무인 open → 전체 pagination → 페이지 이미지 생성이 성공한다.
- [ ] benchmark 3종과 한컴 저작 HWPX 5종을 고정 manifest로 잠근다.
- [ ] 방향/MediaBox 불일치는 쪽수 비교 전에 실패한다.
- [ ] 우리 own-render와 쪽수 ±1, 페이지 이미지 diff를 함께 보고한다(쪽수 하나만으로 통과 금지).
- [ ] 한글/OS/글꼴 버전이 바뀌면 기존 골든을 조용히 덮지 않고 별도 baseline 승인을 요구한다.

