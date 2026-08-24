# Public corpus intake — 권리·개인정보·컨테이너 검증을 통과한 50개

정본은 `public-corpus-manifest.json`이다. #99 후보 카탈로그의 메타데이터만 믿지 않고 원 게시물의
권리 표기와 공개 접근성을 다시 확인한 뒤, 실제 바이트를 내려받아 HWP5 CFB·HWPX OWPML ZIP·PDF
매직, 크기, SHA-256을 측정했다. 바이너리는 `.gitignore`의 `corpus/private/`에만 있으며 이 저장소는
메타데이터만 배포한다.

승격 뒤 40개 HWP/HWPX 전부를 production parser와 `tag-layout`의 `place_doc` 경로로 다시 열었고
40/40이 정상 종료했다. 이 확인은 문서가 안전하게 열리고 조판 feature를 계측할 수 있다는 증거이지,
한/글과의 시각 동일성 점수는 아니다.

first-party HWP5 전환 적격성은 별도 fail-closed 계약이다. 저장소에 직접 커밋된 공개 HWP5 12건과
bounded benchmark 1건은 `hwp5_eligibility_matrix`가 파일명·경로·본문·원본 hash 없이 반복 실행한다.
현재 13건 모두 ineligible이며 실행 계측 사유 집계는 render-parity-unproven 1,
unsupported-semantic 7, unsupported-border-fill 3, unsupported-style-semantics 1,
invalid-container 1이다. private intake 20건이 로컬에 있으면 매트릭스는
자동으로 33건으로 확장되며, 현재 추가 거부 사유는 unsupported-style-semantics 15,
unsupported-border-fill 3, unsupported-table-topology 2다. production parser 40/40 통과와 자체 파서
eligible은 서로 다른 지표다. #200은 benchmark의 빈 run 6개만 증거용 clone에서
정규화했을 때 shared geometry·SVG·PDF가 exact임을 잠그었지만, 전체 candidate/rhwp
geometry는 아직 다르므로 `render-parity-unproven`·eligible=false를 유지한다.

| 형식 | 승격 | 역할 |
|---|---:|---|
| HWP5 | 20 | 법령 별지 빈 양식·표·form-control 축 |
| HWPX | 20 | 보도자료·공고·양식의 표·이미지·차트·각주·다단 축 |
| 공식 PDF | 10 | 같은 법령 별지 HWP5와 `pair_id`로 묶인 시각 비교 reference |

## 권리와 개인정보 경계

- 국가법령정보센터 별지 HWP/PDF 30건은 저작권법 제7조 근거와 같은 공식 source page를 기록했다.
- 기관별 KOGL-0/1 자료는 항목 페이지에서 표기를 확인했다. 정책브리핑 8건은 페이지 문구대로
  **텍스트에 한한 이용**으로 기록했으며 첨부 안 사진·삽화의 재배포를 허용한다고 해석하지 않는다.
- 전 항목은 빈 양식 또는 공식 공개물로 분류하고 `privacy_review.decision=include`를 기록했다.
  작성 완료 문서·민원·명단·개인정보 가능 파일과 격리 결과는 공개 매니페스트에 넣지 않는다.
- 2026-08-23 확인 당시 산업통상부 후보 1건은 공식 페이지의 첨부가 404여서 승격하지 않았다.
  대신 교육부 항목의 KOGL-1 표기와 정상 HWPX 첨부를 브라우저에서 재확인해 사용했다.

## 재현과 실패 규칙

```bash
node scripts/public-corpus-intake.mjs --check  # 공개 메타데이터·20/20/10 계약만, 네트워크 없음
node scripts/public-corpus-intake.mjs          # 승인된 50 URL만 private/에 재현
```

수집기는 HTTPS·자격증명 없는 URL, 명시 redirect host, 매 hop의 public DNS, 전체 30초, 32MiB,
HWPX entry 10,000개·inflate 256MiB·팽창률 500배 상한을 강제한다. HWPX는 ZIP64·암호화·경로 탈출·
local/central 불일치·CRC 오류를 거부하고 HWP5는 CFB FAT/디렉터리와 `FileHeader` 서명까지 확인한다.
기존 파일은 단일-link regular inode와 SHA/크기/컨테이너를 다시 확인하며, 다른 파일을 덮어쓰지 않는다.
로그는 공개 artifact id와 통과/정책 실패만 남기고 문서명·본문·SHA를 출력하지 않는다.

공식 PDF는 한/글 자체 렌더의 절대 참값으로 선언하지 않는다. #101은 HWP5 20건 모두에 대응하는
공식 PDF를 추가 관측해 `pdf-calibration-manifest.json`에 T1 provenance를 고정했다. 이 중 처음
10개만 위 intake manifest의 50건에 포함되고, 추가 10개 역시 바이너리는 private에만 둔다.
`pdf-calibration-baseline.json`은 페이지 구조를 먼저 비교한 report-only 결과이며, #88·#93의
pair/oracle 입력으로 사용한다.
