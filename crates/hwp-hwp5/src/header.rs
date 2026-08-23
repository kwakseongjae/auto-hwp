use serde::Serialize;
use thiserror::Error;

pub const FILE_HEADER_SIZE: usize = 256;
pub const HWP_SIGNATURE: &[u8] = b"HWP Document File";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct HwpVersion {
    pub major: u8,
    pub minor: u8,
    pub build: u8,
    pub revision: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct FileHeaderFlags {
    pub raw: u32,
    pub compressed: bool,
    pub encrypted: bool,
    pub distribution: bool,
    pub script: bool,
    pub drm: bool,
    pub xml_template: bool,
    pub document_history: bool,
    pub digital_signature: bool,
    pub public_key_encrypted: bool,
    pub modified_certificate: bool,
    pub prepare_distribution: bool,
}

impl FileHeaderFlags {
    pub fn from_raw(raw: u32) -> Self {
        Self {
            raw,
            compressed: raw & (1 << 0) != 0,
            encrypted: raw & (1 << 1) != 0,
            distribution: raw & (1 << 2) != 0,
            script: raw & (1 << 3) != 0,
            drm: raw & (1 << 4) != 0,
            xml_template: raw & (1 << 5) != 0,
            document_history: raw & (1 << 6) != 0,
            digital_signature: raw & (1 << 7) != 0,
            public_key_encrypted: raw & (1 << 8) != 0,
            modified_certificate: raw & (1 << 9) != 0,
            prepare_distribution: raw & (1 << 10) != 0,
        }
    }

    /// Flags for which a transparent first-party parse must not infer clear body records.
    pub fn body_is_opaque(self) -> bool {
        self.encrypted || self.distribution || self.drm || self.public_key_encrypted
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct FileHeader {
    pub version: HwpVersion,
    pub flags: FileHeaderFlags,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HeaderError {
    #[error("FileHeader is shorter than {FILE_HEADER_SIZE} bytes: {0}")]
    TooShort(usize),
    #[error("invalid HWP5 FileHeader signature")]
    InvalidSignature,
}

pub fn parse_file_header(data: &[u8]) -> Result<FileHeader, HeaderError> {
    if data.len() < FILE_HEADER_SIZE {
        return Err(HeaderError::TooShort(data.len()));
    }
    let signature = &data[..32];
    if !signature.starts_with(HWP_SIGNATURE) {
        return Err(HeaderError::InvalidSignature);
    }
    Ok(FileHeader {
        version: HwpVersion {
            revision: data[32],
            build: data[33],
            minor: data[34],
            major: data[35],
        },
        flags: FileHeaderFlags::from_raw(u32::from_le_bytes(
            data[36..40].try_into().expect("fixed four-byte slice"),
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(flags: u32) -> Vec<u8> {
        let mut bytes = vec![0; FILE_HEADER_SIZE];
        bytes[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
        bytes[32..36].copy_from_slice(&[7, 6, 1, 5]);
        bytes[36..40].copy_from_slice(&flags.to_le_bytes());
        bytes
    }

    #[test]
    fn parses_exact_version_and_security_flags() {
        let parsed = parse_file_header(&header(0x7ff)).unwrap();
        assert_eq!(
            parsed.version,
            HwpVersion {
                major: 5,
                minor: 1,
                build: 6,
                revision: 7
            }
        );
        assert!(parsed.flags.compressed);
        assert!(parsed.flags.encrypted);
        assert!(parsed.flags.distribution);
        assert!(parsed.flags.prepare_distribution);
        assert!(parsed.flags.body_is_opaque());
    }

    #[test]
    fn rejects_short_and_wrong_signature() {
        assert_eq!(parse_file_header(&[0; 40]), Err(HeaderError::TooShort(40)));
        let mut bytes = header(0);
        bytes[0] = b'X';
        assert_eq!(
            parse_file_header(&bytes),
            Err(HeaderError::InvalidSignature)
        );
    }
}
