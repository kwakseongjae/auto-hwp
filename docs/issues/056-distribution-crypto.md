# 056 — 조건부: 배포용(암호화) .hwp 복호화

- 상태: **done** (c716e8f, 062-1) · 우선순위: 조건부→해소 · 영역: crates/hwp-crypto
- **핵심 발견(2026-07-13)**: 배포용(무암호) .hwp는 **이미 rhwp 경로로 열린다**(`.hwp` open → rhwp
  `from_bytes`가 distribution 플래그 감지→내부 복호, wasm 포함). 즉 056의 사용자 가시 능력은 이미 동작 중이었음.
  062-1은 우리 소유 `hwp-crypto`를 NIST 골든 벡터 + fail-closed 무결성(키재료 UTF-16LE hex 검증 +
  첫 레코드 tag 검증)까지 갖춘 **정본 복호기로 승격**(rhwp 내부 크립토 은퇴 시 교체 가능). AES-128-ECB
  = RustCrypto aes+cipher(MIT/Apache, deny ok). 잔여: 실배포용 샘플 1건(합성 골든으로 CI 확보), 암호(password)
  문서는 스코프 밖(NotImplemented 정직 거부).

## 근거
`crates/hwp-crypto/src/lib.rs` `decrypt_distribution()`이 NotImplemented 스텁 — 기관 배포
(암호화) .hwp가 열리지 않는다. 알고리즘은 알려져 있음: MSVC rand 시드 → SHA-1 → AES-128-ECB
(주석에 golden-vector 계획 명시). 공공/기관 사용자 비중이 크면 하드 블로커.

## 목표
배포용 .hwp를 열어 읽기/편집/export까지 일반 .hwp와 동일 파이프라인에 태운다.

## 설계
1. golden vector 확보(실제 배포용 샘플 + 알려진 평문 쌍) — **이게 없으면 착수 금지**(검증 불가).
2. MSVC rand 재현 → SHA-1 키 유도 → AES-128-ECB 복호 → 기존 CFB 파스로 합류.
3. wasm 호환(순수 Rust 구현 — getrandom 불필요, 복호는 결정적), 014 한도가 복호 후 크기에도 적용.
4. 테스트: golden vector 왕복, 손상 암호문 fail-closed, 게이트/wasm-safe.

## 수용 기준
- [ ] golden vector 기반 복호 검증, 복호 후 일반 파이프라인 합류(렌더/편집/export)
- [ ] 실패 시 정직한 에러(포맷/버전 미지원 구분), wasm 포함 전 셸 동작
- [ ] 014 한도 적용 확인, 게이트 그린

## 함정
- 법적 검토: 복호는 사용자가 정당 열람 권한을 가진 문서에 한함 — 제품 문구/약관에 명시(코드 밖).
- ECB 특성상 부분 손상 파일이 "그럴듯하게" 열릴 수 있음 — 무결성 검증(해시/구조 검사) 후 통과.

## 리서치 결론 (2026-07-11 — 외부 교차검증 pyhwp/hwp-rs/Volexity + rhwp in-repo)
**알고리즘·라이선스·의존 리스크는 이미 해소. 남은 블로커는 실샘플 1건 + 배선 결정뿐 — 배포용 한정이면 지금 착수 가능.**
- **알고리즘 확정**: 배포용 체인(MSVC-rand 214013/2531011 → 256B XOR → offset `4+(seed&0xF)` 키 추출 → AES-128-ECB)이 pyhwp `distdoc.py`·hwp-rs `from_distributed`와 **바이트 단위 동일**. `external/rhwp/src/crypto.rs`에 **이미 작동 구현이 in-repo(MIT)**. 배포용 판정: `header.rs:82 distribution=(flags&0x04)`, tag `HWPTAG_BEGIN+12=0x1C`.
- **표기 정정**: 배포용은 **복호 시점에 SHA-1을 계산하지 않음**(키가 레코드에 박힘 — `SHA-1(pw)` 40hex의 UTF-16LE 80B 중 앞 16B). 진짜 password 경로만 KDF를 돌고, 그건 **ECB 아니라 AES-128 위 1-bit CFB + 커스텀 KDF**(Volexity) — **056 스코프 밖, 상위 난이도**. 이슈 본문의 "SHA-1→AES-ECB" 표기를 이에 맞게 정밀화할 것.
- **crate(라이선스 청정)**: `aes`+`cipher`(MIT OR Apache) 직접 ECB 구동, `sha1`(dual). `ecb` crate(MIT 단독) 회피. 순수 Rust·wasm·getrandom 불필요. **이식 베이스 = rhwp `crypto.rs`(MIT) 또는 hwp-rs(Apache)**. pyhwp=AGPL 코드복사 금지(알고리즘 참조만).
- **fail-closed 보강(056 함정 충족)**: rhwp `extract_aes_key`는 무검증 → 이식 시 추가 — ① 80B가 40 ASCII hex의 UTF-16LE인지(홀수 바이트 0x00, 짝수 hex) ② 복호+inflate 후 첫 레코드 tag=`HWPTAG_PARA_HEADER 0x42` 검증. MAC 없는 스킴의 유일한 견고한 거부 근거.
- **golden vector**: 어느 레포도 배포용 픽스처 미배포 → **encrypt 방향 합성**(XOR 자기역원+ECB 대칭: pw→sha1_hex→UTF-16LE(80B), seed 선택→offset→256B 레코드 조립→SRand XOR→유효 레코드 16정렬 ECB→합성)으로 CI 골든 확보. 실샘플 1건 확보가 최종 게이트로 여전히 유효.
