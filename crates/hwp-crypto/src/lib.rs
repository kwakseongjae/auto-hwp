//! HWP **배포용(distribution)** 문서 복호화 — 이슈 062-1 (056 해소).
//!
//! `external/rhwp/src/parser/crypto.rs`(MIT, 우리 소유)의 검증된 구현을 **읽어서 이식**한 것이다
//! (vendored 파일은 수정하지 않는다 — 어댑터/재구현 방식). rhwp의 손수 짠 AES는 감사받은 순수 Rust
//! `aes` 크레이트로 교체했고, rhwp에 **없던** fail-closed 무결성 검증 2종을 추가했다.
//!
//! ## 알고리즘 (배포용 체인 — pyhwp `distdoc.py` / hwp-rs `from_distributed`와 바이트 단위 동일)
//! ViewText/Section{N} 스트림 = `[HWPTAG_DISTRIBUTE_DOC_DATA 레코드(256B)]` + `[AES-128-ECB 암호문]`.
//! 1. 첫 레코드(256B)의 앞 4바이트를 MSVC `srand` 시드로 삼아 LCG(`214013`/`2531011`)를 돌린다.
//! 2. LCG로 256B 바이트를 XOR 복호(오프셋 4부터). 이 XOR은 **자기역원**이라 encrypt=decrypt.
//! 3. 복호된 256B의 `offset = 4 + (byte0 & 0xF)` 위치에서 **80바이트 키재료**를 읽는다. 이는
//!    `SHA-1(password)`의 40자리 hex를 UTF-16LE로 인코딩한 것이며, AES-128 키 = 그 앞 16바이트다.
//!    **복호 시점에 SHA-1을 계산하지 않는다** — 키가 레코드에 박혀 있다(배포용의 핵심).
//! 4. 레코드 뒤 암호문을 AES-128-**ECB**로 복호한다.
//! 5. FileHeader의 `compressed` 플래그가 서 있으면 raw-deflate/zlib로 inflate → BodyText와 동일한
//!    레코드 스트림을 얻는다.
//!
//! ## fail-closed 무결성 (rhwp에 없음 — MAC 없는 스킴의 유일한 견고한 거부 근거)
//! - **①** 80바이트 키재료가 "40개 ASCII hex의 UTF-16LE"인지 검증(짝수 바이트 = hex, 홀수 바이트 = 0x00).
//!   ECB 특성상 잘못된/손상된 입력은 그럴듯한 평문을 만들 수 있으나 이 구조를 만족할 확률은 무시 가능.
//! - **②** 복호+inflate 후 **첫 레코드 tag == `HWPTAG_PARA_HEADER`(0x42)** 인지 검증.
//!
//! 두 검증 중 하나라도 실패하면 **정직하게 거부**한다(그럴듯하게 열지 않는다).
//!
//! ## 스코프
//! **배포용 전용.** 진짜 password 문서(사용자 비번 → SHA-1 KDF → AES-CFB, Volexity)는 별개의 상위
//! 난이도 스킴이며 여기서 다루지 않는다 — `decrypt_distribution(_, Some(pw))`는 `NotImplemented`로
//! 정직하게 거부한다.

use hwp_model::error::{Error, Result};

// ── 레코드 태그 (external/rhwp/src/parser/tags.rs 미러; HWPTAG_BEGIN = 0x010) ──
const HWPTAG_BEGIN: u16 = 0x010;
/// 배포용 헤더 레코드(256B payload) — `HWPTAG_BEGIN + 12`.
const HWPTAG_DISTRIBUTE_DOC_DATA: u16 = HWPTAG_BEGIN + 12; // 0x1C
/// 문단 헤더 — `HWPTAG_BEGIN + 50`. 복호 후 BodyText 스트림의 첫 레코드여야 한다.
const HWPTAG_PARA_HEADER: u16 = HWPTAG_BEGIN + 50; // 0x42

/// 배포용 헤더 레코드 payload 크기(고정).
const DIST_HEADER_LEN: usize = 256;
/// in-record 키재료 크기 = UTF-16LE(40 hex) = 80바이트.
const KEY_MATERIAL_LEN: usize = 80;
/// AES-128 키 크기.
const AES_KEY_LEN: usize = 16;

// ============================================================
// 에러
// ============================================================

/// 배포용 복호화 에러 (모두 fail-closed 거부 사유).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// 첫 레코드가 DISTRIBUTE_DOC_DATA가 아님.
    NoDistributeData,
    /// DISTRIBUTE_DOC_DATA payload 크기 오류(256 아님).
    InvalidPayloadSize(usize),
    /// 키 추출 위치/길이 오류.
    KeyExtractionFailed(String),
    /// fail-closed ①: 키재료가 UTF-16LE(40 hex) 구조가 아님.
    KeyIntegrity(String),
    /// fail-closed ②: 복호+inflate 후 첫 레코드가 PARA_HEADER가 아님.
    IntegrityCheckFailed(String),
    /// 복호화 실패(본문 없음 등).
    DecryptionFailed(String),
    /// 레코드 파싱 실패.
    RecordError(String),
    /// 압축 해제 실패.
    DecompressError(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::NoDistributeData => {
                write!(
                    f,
                    "첫 레코드가 DISTRIBUTE_DOC_DATA가 아님 (배포용 문서 아님)"
                )
            }
            CryptoError::InvalidPayloadSize(s) => {
                write!(f, "DISTRIBUTE_DOC_DATA 크기 오류: {s}바이트 (필요: 256)")
            }
            CryptoError::KeyExtractionFailed(e) => write!(f, "AES 키 추출 실패: {e}"),
            CryptoError::KeyIntegrity(e) => {
                write!(f, "키 무결성 검증 실패(UTF-16LE hex 아님): {e}")
            }
            CryptoError::IntegrityCheckFailed(e) => {
                write!(f, "복호 무결성 검증 실패(첫 레코드 ≠ PARA_HEADER): {e}")
            }
            CryptoError::DecryptionFailed(e) => write!(f, "복호화 실패: {e}"),
            CryptoError::RecordError(e) => write!(f, "레코드 파싱 실패: {e}"),
            CryptoError::DecompressError(e) => write!(f, "압축 해제 실패: {e}"),
        }
    }
}

impl std::error::Error for CryptoError {}

impl From<CryptoError> for Error {
    fn from(e: CryptoError) -> Self {
        match e {
            // 형식/구조 문제 → parse 계열
            CryptoError::NoDistributeData
            | CryptoError::InvalidPayloadSize(_)
            | CryptoError::RecordError(_) => Error::Parse(e.to_string()),
            // 복호/무결성 문제 → 정직한 거부(그럴듯하게 열지 않음)
            CryptoError::KeyExtractionFailed(_)
            | CryptoError::KeyIntegrity(_)
            | CryptoError::IntegrityCheckFailed(_)
            | CryptoError::DecryptionFailed(_)
            | CryptoError::DecompressError(_) => Error::Other(e.to_string()),
        }
    }
}

// ============================================================
// MSVC LCG (srand/rand 호환)
// ============================================================

/// MSVC `rand()` 호환 선형 합동 생성기.
struct MsvcLcg {
    seed: u32,
}

impl MsvcLcg {
    fn new(seed: u32) -> Self {
        MsvcLcg { seed }
    }

    /// 다음 난수 (0 ~ 32767).
    fn rand(&mut self) -> u32 {
        self.seed = self.seed.wrapping_mul(214013).wrapping_add(2531011);
        (self.seed >> 16) & 0x7FFF
    }
}

// ============================================================
// DISTRIBUTE_DOC_DATA 256B XOR (자기역원 → encrypt == decrypt)
// ============================================================

/// 256B payload를 LCG+XOR로 변환한다. XOR은 자기역원이라 이 함수 하나가 복호·암호를 모두 담당한다.
fn transform_distribute_doc_data(data: &[u8]) -> std::result::Result<[u8; 256], CryptoError> {
    if data.len() < DIST_HEADER_LEN {
        return Err(CryptoError::InvalidPayloadSize(data.len()));
    }

    let mut out = [0u8; DIST_HEADER_LEN];
    out.copy_from_slice(&data[..DIST_HEADER_LEN]);

    // 앞 4바이트 = 시드(변경하지 않음).
    let seed = u32::from_le_bytes([out[0], out[1], out[2], out[3]]);
    let mut lcg = MsvcLcg::new(seed);

    let mut i = 0usize;
    let mut n = 0u32;
    let mut key = 0u8;
    while i < DIST_HEADER_LEN {
        if n == 0 {
            key = (lcg.rand() & 0xFF) as u8;
            n = (lcg.rand() & 0xF) + 1;
        }
        if i >= 4 {
            out[i] ^= key;
        }
        i += 1;
        n -= 1;
    }

    Ok(out)
}

/// 복호된 256B에서 AES-128 키를 추출하고 **fail-closed ①**(UTF-16LE hex 구조)을 검증한다.
fn extract_and_validate_key(header: &[u8; 256]) -> std::result::Result<[u8; 16], CryptoError> {
    let offset = 4 + (header[0] & 0x0F) as usize; // 4..=19
    if offset + KEY_MATERIAL_LEN > header.len() {
        return Err(CryptoError::KeyExtractionFailed(format!(
            "offset {offset}에서 {KEY_MATERIAL_LEN}바이트 키재료 부족"
        )));
    }

    let key_material = &header[offset..offset + KEY_MATERIAL_LEN];

    // ①: 40 ASCII hex의 UTF-16LE → 짝수 인덱스 = hex 문자, 홀수 인덱스 = 0x00.
    for (j, &b) in key_material.iter().enumerate() {
        if j % 2 == 1 {
            if b != 0x00 {
                return Err(CryptoError::KeyIntegrity(format!(
                    "UTF-16LE 상위바이트(idx {}) = {:#04x}, 기대 0x00",
                    offset + j,
                    b
                )));
            }
        } else if !b.is_ascii_hexdigit() {
            return Err(CryptoError::KeyIntegrity(format!(
                "비-hex 키바이트(idx {}) = {:#04x}",
                offset + j,
                b
            )));
        }
    }

    // AES 키 = 키재료의 앞 16바이트 (= 앞 8개 hex 문자의 UTF-16LE). rhwp와 바이트 동일.
    let mut key = [0u8; AES_KEY_LEN];
    key.copy_from_slice(&key_material[..AES_KEY_LEN]);
    Ok(key)
}

// ============================================================
// AES-128-ECB (RustCrypto `aes` + 재-export된 `cipher` 트레잇)
// ============================================================

/// AES-128-ECB 복호. 마지막 블록이 16의 배수가 아니면 0으로 채워 처리(실암호문은 항상 16배수).
fn decrypt_aes_ecb(data: &[u8], key: &[u8; 16]) -> Vec<u8> {
    use aes::cipher::generic_array::GenericArray;
    use aes::cipher::{BlockDecrypt, KeyInit};
    use aes::Aes128;

    let cipher = Aes128::new(GenericArray::from_slice(key));
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut block = [0u8; 16];
        block[..chunk.len()].copy_from_slice(chunk);
        let mut ga = GenericArray::clone_from_slice(&block);
        cipher.decrypt_block(&mut ga);
        out.extend_from_slice(&ga);
    }
    out
}

// ============================================================
// inflate (raw deflate → zlib 폴백; miniz_oxide 백엔드 → wasm-safe)
// ============================================================

fn inflate(data: &[u8]) -> std::result::Result<Vec<u8>, String> {
    use flate2::read::{DeflateDecoder, ZlibDecoder};
    use std::io::Read;

    // raw deflate (wbits = -15)
    let mut out = Vec::new();
    if DeflateDecoder::new(data).read_to_end(&mut out).is_ok() {
        return Ok(out);
    }
    // 표준 zlib 폴백
    out.clear();
    ZlibDecoder::new(data)
        .read_to_end(&mut out)
        .map(|_| out)
        .map_err(|e| e.to_string())
}

// ============================================================
// 레코드 헤더 파싱 (첫 레코드만)
// ============================================================

struct RawRecord {
    tag_id: u16,
    /// 레코드 헤더 바이트 수(4 또는 확장 시 8).
    header_len: usize,
    /// payload 크기.
    size: usize,
    /// payload 바이트.
    data: Vec<u8>,
}

/// 바이트 스트림에서 첫 레코드 헤더만 파싱한다.
///
/// 주의: 배포용 ViewText는 `[레코드][AES 암호문]` 구조라 전체를 레코드로 파싱하면 안 된다 —
/// 첫 레코드만 읽고 암호문 위치를 계산한다.
fn read_first_record(data: &[u8]) -> std::result::Result<RawRecord, String> {
    if data.len() < 4 {
        return Err("데이터가 4바이트 미만".to_string());
    }
    let header = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let tag_id = (header & 0x3FF) as u16;
    let mut size = ((header >> 20) & 0xFFF) as usize;
    let mut header_len = 4usize;

    if size == 0xFFF {
        if data.len() < 8 {
            return Err("확장 크기 필드(4B)가 잘림".to_string());
        }
        size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
        header_len = 8;
    }

    if header_len + size > data.len() {
        return Err(format!(
            "레코드 데이터 부족: tag={}, 필요={}, 가용={}",
            tag_id,
            size,
            data.len() - header_len
        ));
    }

    Ok(RawRecord {
        tag_id,
        header_len,
        size,
        data: data[header_len..header_len + size].to_vec(),
    })
}

// ============================================================
// 공개 API
// ============================================================

/// 배포용 ViewText 섹션을 복호한다.
///
/// `section_data` = `/ViewText/Section{N}` 원본 바이트. `compressed` = FileHeader의 압축 플래그.
/// 반환값은 BodyText와 동일한 **레코드 스트림**(첫 레코드는 PARA_HEADER).
///
/// fail-closed: 키재료 구조(①) 또는 첫 레코드 tag(②)가 어긋나면 정직하게 거부한다.
pub fn decrypt_viewtext_section(
    section_data: &[u8],
    compressed: bool,
) -> std::result::Result<Vec<u8>, CryptoError> {
    // 1) 첫 레코드 = DISTRIBUTE_DOC_DATA(256B)
    let first = read_first_record(section_data).map_err(CryptoError::RecordError)?;
    if first.tag_id != HWPTAG_DISTRIBUTE_DOC_DATA {
        return Err(CryptoError::NoDistributeData);
    }
    if first.size != DIST_HEADER_LEN {
        return Err(CryptoError::InvalidPayloadSize(first.size));
    }

    // 2) 256B XOR 복호 → 3) 키 추출 + 무결성 ①
    let mut header = [0u8; DIST_HEADER_LEN];
    header.copy_from_slice(&first.data[..DIST_HEADER_LEN]);
    let decrypted_header = transform_distribute_doc_data(&header)?;
    let aes_key = extract_and_validate_key(&decrypted_header)?;

    // 4) 레코드 뒤 암호문을 AES-128-ECB 복호
    let encrypted_start = first.header_len + first.size;
    if section_data.len() <= encrypted_start {
        return Err(CryptoError::DecryptionFailed(
            "암호화된 본문 데이터 없음".to_string(),
        ));
    }
    let decrypted_body = decrypt_aes_ecb(&section_data[encrypted_start..], &aes_key);

    // 5) inflate
    let record_stream = if compressed {
        inflate(&decrypted_body).map_err(CryptoError::DecompressError)?
    } else {
        decrypted_body
    };

    // ②: 첫 레코드 tag == PARA_HEADER
    let rec = read_first_record(&record_stream).map_err(|e| {
        CryptoError::IntegrityCheckFailed(format!("복호 스트림 레코드 파싱 실패: {e}"))
    })?;
    if rec.tag_id != HWPTAG_PARA_HEADER {
        return Err(CryptoError::IntegrityCheckFailed(format!(
            "첫 레코드 tag = {:#x} (기대 PARA_HEADER {:#x})",
            rec.tag_id, HWPTAG_PARA_HEADER
        )));
    }

    Ok(record_stream)
}

/// 배포용/password 스트림 복호화 (엔진 파사드).
///
/// - `password = None` → 배포용 ViewText로 간주하고 복호한다. 실제 배포 문서는 본문이 deflate로
///   압축돼 있으므로 압축 가정으로 먼저 시도하고, 압축/무결성 실패 시 비압축으로 재시도한다.
///   (압축 여부를 아는 호출자는 [`decrypt_viewtext_section`]에 정확한 플래그를 넘기는 것이 좋다.)
/// - `password = Some(_)` → 진짜 password 문서는 스코프 밖. 정직하게 `NotImplemented`.
pub fn decrypt_distribution(data: &[u8], password: Option<&str>) -> Result<Vec<u8>> {
    if password.is_some() {
        return Err(Error::NotImplemented(
            "password 보호 .hwp 복호화(사용자 비번 SHA-1 KDF + AES-CFB) — 이 빌드는 배포용 전용",
        ));
    }
    match decrypt_viewtext_section(data, true) {
        Ok(v) => Ok(v),
        // 본문이 비압축이었을 수 있음 → 비압축으로 재시도.
        Err(CryptoError::DecompressError(_)) | Err(CryptoError::IntegrityCheckFailed(_)) => {
            decrypt_viewtext_section(data, false).map_err(Error::from)
        }
        Err(e) => Err(Error::from(e)),
    }
}

// ============================================================
// 테스트 (골든 벡터: NIST AES 벡터 + 합성 배포 문서 왕복 + fail-closed 음성)
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── 합성 헬퍼 (encrypt 방향 — 056 §리서치) ──

    fn utf16le(s: &str) -> Vec<u8> {
        let mut v = Vec::with_capacity(s.len() * 2);
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }

    /// password → SHA-1 hex(40자) → UTF-16LE(80B) 키재료.
    fn key_material_from_pw(pw: &str) -> [u8; 80] {
        use sha1::{Digest, Sha1};
        let digest = Sha1::digest(pw.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex.len(), 40, "SHA-1 hex는 40자");
        let bytes = utf16le(&hex);
        let mut km = [0u8; 80];
        km.copy_from_slice(&bytes);
        km
    }

    fn push_record(out: &mut Vec<u8>, tag: u16, level: u16, body: &[u8]) {
        let size = body.len() as u32;
        assert!(size < 0xFFF, "테스트 레코드는 확장 크기 미사용");
        let header = (tag as u32 & 0x3FF) | ((level as u32 & 0x3FF) << 10) | ((size & 0xFFF) << 20);
        out.extend_from_slice(&header.to_le_bytes());
        out.extend_from_slice(body);
    }

    /// 최소 BodyText 레코드 스트림: 첫 레코드는 PARA_HEADER, 뒤에 filler 하나.
    fn body_stream(first_tag: u16) -> Vec<u8> {
        let mut s = Vec::new();
        push_record(&mut s, first_tag, 0, &[0xAB; 22]); // PARA_HEADER body(내용 무관)
        push_record(&mut s, HWPTAG_BEGIN + 51, 1, b"hello-distribution"); // PARA_TEXT-ish filler
        s
    }

    fn aes_encrypt_ecb(data: &[u8], key: &[u8; 16]) -> Vec<u8> {
        use aes::cipher::generic_array::GenericArray;
        use aes::cipher::{BlockEncrypt, KeyInit};
        use aes::Aes128;
        let cipher = Aes128::new(GenericArray::from_slice(key));
        let mut out = Vec::new();
        for chunk in data.chunks(16) {
            let mut block = [0u8; 16];
            block[..chunk.len()].copy_from_slice(chunk);
            let mut ga = GenericArray::clone_from_slice(&block);
            cipher.encrypt_block(&mut ga);
            out.extend_from_slice(&ga);
        }
        out
    }

    fn deflate_raw(data: &[u8]) -> Vec<u8> {
        use flate2::{write::DeflateEncoder, Compression};
        use std::io::Write;
        let mut e = DeflateEncoder::new(Vec::new(), Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    /// 완전한 ViewText 섹션을 합성한다(encrypt 방향).
    fn synthesize_section(
        key_material: &[u8; 80],
        record_stream: &[u8],
        compressed: bool,
        seed: u32,
    ) -> Vec<u8> {
        let aes_key: [u8; 16] = key_material[..16].try_into().unwrap();

        // 복호될 256B 조립: 시드 + offset 위치에 키재료.
        let mut plain = [0u8; 256];
        plain[..4].copy_from_slice(&seed.to_le_bytes());
        let offset = 4 + (plain[0] & 0x0F) as usize;
        plain[offset..offset + 80].copy_from_slice(key_material);

        // XOR 자기역원 → 같은 함수로 "암호화".
        let enc_header = transform_distribute_doc_data(&plain).unwrap();

        // 본문: (선택) deflate → AES-128-ECB.
        let body_plain = if compressed {
            deflate_raw(record_stream)
        } else {
            record_stream.to_vec()
        };
        let body_ct = aes_encrypt_ecb(&body_plain, &aes_key);

        // 섹션 = DISTRIBUTE_DOC_DATA 레코드(헤더+256B) + AES 암호문.
        let mut section = Vec::new();
        push_record(&mut section, HWPTAG_DISTRIBUTE_DOC_DATA, 0, &enc_header);
        section.extend_from_slice(&body_ct);
        section
    }

    // ── MSVC LCG ──

    #[test]
    fn lcg_range_and_deterministic() {
        let mut a = MsvcLcg::new(12345);
        let mut b = MsvcLcg::new(12345);
        for _ in 0..64 {
            let (x, y) = (a.rand(), b.rand());
            assert_eq!(x, y, "같은 시드 → 같은 시퀀스");
            assert!(x <= 0x7FFF, "rand() ∈ [0, 32767]");
        }
    }

    // ── AES 골든 벡터 (NIST FIPS-197 부록 B) ──

    #[test]
    fn aes128_ecb_nist_vector() {
        // FIPS-197 Appendix B: key/plaintext/ciphertext.
        let key = [
            0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf,
            0x4f, 0x3c,
        ];
        let plaintext = [
            0x32, 0x43, 0xf6, 0xa8, 0x88, 0x5a, 0x30, 0x8d, 0x31, 0x31, 0x98, 0xa2, 0xe0, 0x37,
            0x07, 0x34,
        ];
        let ciphertext = [
            0x39, 0x25, 0x84, 0x1d, 0x02, 0xdc, 0x09, 0xfb, 0xdc, 0x11, 0x85, 0x97, 0x19, 0x6a,
            0x0b, 0x32,
        ];
        // 복호 방향 검증(파이프라인이 쓰는 방향).
        assert_eq!(decrypt_aes_ecb(&ciphertext, &key), plaintext);
        // 합성 헬퍼(암호 방향)도 같은 벡터를 재현.
        assert_eq!(aes_encrypt_ecb(&plaintext, &key), ciphertext);
    }

    // ── 배포 문서 왕복 (골든 red→green) ──

    #[test]
    fn distribution_roundtrip_compressed() {
        let km = key_material_from_pw("2026-distribution-secret");
        let plain = body_stream(HWPTAG_PARA_HEADER);
        // offset != 4 케이스(seed 하위 니블 3 → offset 7, rhwp 테스트와 정합).
        let section = synthesize_section(&km, &plain, true, 0x0000_0003);

        let got = decrypt_viewtext_section(&section, true).expect("배포 복호 성공");
        assert_eq!(got, plain, "복호+inflate 결과가 원본 레코드 스트림과 동일");

        // 파사드도 압축 자동 감지로 성공.
        assert_eq!(decrypt_distribution(&section, None).unwrap(), plain);
    }

    #[test]
    fn distribution_roundtrip_uncompressed_offset0() {
        let km = key_material_from_pw("another-org-doc");
        let plain = body_stream(HWPTAG_PARA_HEADER);
        // seed 하위 니블 0 → offset 4 (키재료가 시드 바로 뒤).
        let section = synthesize_section(&km, &plain, false, 0x1234_5670);

        let got = decrypt_viewtext_section(&section, false).expect("비압축 배포 복호 성공");
        assert_eq!(got, plain);
        // 파사드: 압축 시도 실패 → 비압축 재시도로 성공.
        assert_eq!(decrypt_distribution(&section, None).unwrap(), plain);
    }

    // ── fail-closed 음성 ──

    #[test]
    fn fail_closed_bad_key_material() {
        // ①: 키재료가 UTF-16LE hex 구조가 아님(전부 0xFF → 짝수 바이트가 hex 아님).
        let bad_km = [0xFFu8; 80];
        let plain = body_stream(HWPTAG_PARA_HEADER);
        let section = synthesize_section(&bad_km, &plain, true, 0x0000_0003);

        match decrypt_viewtext_section(&section, true) {
            Err(CryptoError::KeyIntegrity(_)) => {}
            other => panic!("키 무결성 거부 기대, 실제: {other:?}"),
        }
        // 파사드도 Err(정직한 거부).
        assert!(decrypt_distribution(&section, None).is_err());
    }

    #[test]
    fn fail_closed_wrong_first_record() {
        // ②: 키재료는 유효하지만 복호 스트림 첫 레코드가 PARA_HEADER가 아님.
        let km = key_material_from_pw("valid-key-wrong-body");
        let not_para = body_stream(HWPTAG_BEGIN + 51); // PARA_TEXT-ish tag ≠ 0x42
        let section = synthesize_section(&km, &not_para, true, 0x0000_0003);

        match decrypt_viewtext_section(&section, true) {
            Err(CryptoError::IntegrityCheckFailed(_)) => {}
            other => panic!("복호 무결성 거부 기대, 실제: {other:?}"),
        }
    }

    #[test]
    fn fail_closed_not_distribution() {
        // 첫 레코드가 DISTRIBUTE_DOC_DATA가 아님.
        let mut section = Vec::new();
        push_record(&mut section, HWPTAG_PARA_HEADER, 0, &[0u8; 8]);
        assert_eq!(
            decrypt_viewtext_section(&section, true),
            Err(CryptoError::NoDistributeData)
        );
    }

    #[test]
    fn fail_closed_empty_and_short() {
        assert!(matches!(
            decrypt_viewtext_section(&[], true),
            Err(CryptoError::RecordError(_))
        ));
        // DISTRIBUTE_DOC_DATA지만 payload가 256 아님.
        let mut section = Vec::new();
        push_record(&mut section, HWPTAG_DISTRIBUTE_DOC_DATA, 0, &[0u8; 100]);
        assert_eq!(
            decrypt_viewtext_section(&section, true),
            Err(CryptoError::InvalidPayloadSize(100))
        );
    }

    #[test]
    fn password_path_out_of_scope() {
        // 진짜 password 문서는 NotImplemented(정직).
        let err = decrypt_distribution(&[], Some("hunter2")).unwrap_err();
        assert!(matches!(err, Error::NotImplemented(_)));
    }

    #[test]
    fn xor_transform_is_self_inverse() {
        let mut data = [0u8; 256];
        for (i, b) in data.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(3);
        }
        // 시드는 앞 4바이트에서 결정되고 XOR에서 불변.
        let once = transform_distribute_doc_data(&data).unwrap();
        let twice = transform_distribute_doc_data(&once).unwrap();
        assert_eq!(twice, data, "XOR 변환은 자기역원");
        assert_eq!(&once[..4], &data[..4], "앞 4바이트(시드)는 불변");
    }
}
