//! 배포용(distribution) + password-protected decryption. **Phase 5+.**
//!
//! Real chain (must be golden-vector pinned, cross-checked vs volexity/hwp-extract;
//! NOT openhwp's non-functional XOR stub): `HWPTAG_DISTRIBUTE_DOC_DATA` 256-byte record
//! → MSVC `srand/rand` LCG seeded from first 4 bytes → 256-byte XOR table → UTF-16LE
//! SHA-1 hex key → AES-128-ECB on ViewText. Fail **closed** on bad password.

use hwp_model::error::{Error, Result};

/// Decrypt a distribution/password-protected stream. Stub: fails closed.
pub fn decrypt_distribution(_data: &[u8], _password: Option<&str>) -> Result<Vec<u8>> {
    Err(Error::NotImplemented(
        "배포용/password decryption (Phase 5+; golden-vector MSVC-rand → SHA-1 → AES-128-ECB)",
    ))
}
