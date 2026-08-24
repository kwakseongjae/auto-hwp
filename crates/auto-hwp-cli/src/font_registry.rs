use std::io::Write;
use std::path::{Path, PathBuf};

use hwp_session::font_registry::{
    FontFaceInput, FontRealizationReport, FontRegistry, FontRegistryLimits, FontStyle,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    #[serde(default)]
    limits: ManifestLimits,
    faces: Vec<ManifestFace>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestLimits {
    max_faces: Option<usize>,
    max_face_bytes: Option<usize>,
    max_total_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFace {
    family: String,
    style: FontStyle,
    path: PathBuf,
    sha256: String,
    #[serde(default)]
    face_index: u32,
}

pub fn load(path: &Path) -> Result<FontRegistry, String> {
    require_regular_non_symlink(path, "font registry manifest")?;
    let bytes = std::fs::read(path).map_err(|error| format!("read font registry: {error}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("font registry manifest exceeds 1 MiB".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid font registry: {error}"))?;
    if manifest.schema_version != 1 {
        return Err("font registry schema_version must be 1".into());
    }
    let defaults = FontRegistryLimits::default();
    let limits = FontRegistryLimits {
        max_faces: manifest.limits.max_faces.unwrap_or(defaults.max_faces),
        max_face_bytes: manifest
            .limits
            .max_face_bytes
            .unwrap_or(defaults.max_face_bytes),
        max_total_bytes: manifest
            .limits
            .max_total_bytes
            .unwrap_or(defaults.max_total_bytes),
    };
    if limits.max_faces == 0 || limits.max_face_bytes == 0 || limits.max_total_bytes == 0 {
        return Err("font registry limits must be positive".into());
    }
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let mut inputs = Vec::with_capacity(manifest.faces.len());
    for face in manifest.faces {
        let face_path = if face.path.is_absolute() {
            face.path
        } else {
            base.join(face.path)
        };
        require_regular_non_symlink(&face_path, "font face")?;
        let bytes =
            std::fs::read(&face_path).map_err(|error| format!("read font face: {error}"))?;
        let actual = hex_sha256(&bytes);
        if !valid_sha256(&face.sha256) || !actual.eq_ignore_ascii_case(&face.sha256) {
            return Err("font face SHA-256 mismatch".into());
        }
        inputs.push(FontFaceInput {
            family: face.family,
            style: face.style,
            bytes,
            face_index: face.face_index,
        });
    }
    FontRegistry::new(inputs, limits)
}

pub fn write_report_new(path: &Path, report: &FontRealizationReport) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("serialize font realization report: {error}"))?;
    bytes.push(b'\n');
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("create font realization report: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("write font realization report: {error}"))
}

fn require_regular_non_symlink(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| format!("inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(format!("{label} must be a regular non-symlink file"));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex_sha256(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_rejects_unknown_fields_and_non_integral_indices() {
        let unknown = br#"{"schema_version":1,"faces":[],"surprise":true}"#;
        assert!(serde_json::from_slice::<Manifest>(unknown).is_err());
        let face_unknown = br#"{"schema_version":1,"faces":[{"family":"A","style":"regular","path":"a.ttf","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extra":1}]}"#;
        assert!(serde_json::from_slice::<Manifest>(face_unknown).is_err());
        let fractional = br#"{"schema_version":1,"faces":[{"family":"A","style":"regular","path":"a.ttf","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","face_index":0.5}]}"#;
        assert!(serde_json::from_slice::<Manifest>(fractional).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn loader_rejects_a_symlink_font_before_reading_it() {
        use std::os::unix::fs::symlink;
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "auto-hwp-font-registry-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let real = dir.join("real.ttf");
        let link = dir.join("linked.ttf");
        let manifest = dir.join("registry.json");
        std::fs::write(&real, [0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
        symlink(&real, &link).unwrap();
        std::fs::write(
            &manifest,
            format!(
                "{{\"schema_version\":1,\"faces\":[{{\"family\":\"A\",\"style\":\"regular\",\"path\":\"{}\",\"sha256\":\"{}\"}}]}}",
                link.display(),
                "0".repeat(64)
            ),
        )
        .unwrap();
        assert!(load(&manifest).unwrap_err().contains("non-symlink"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
