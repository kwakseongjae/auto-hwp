//! 사용자가 되돌아갈 수 있는 **버전 기록** (이슈 261).
//!
//! ## 왜 `recovery.rs` 를 재사용하지 않는가
//!
//! 복구 스냅샷(#141)은 *"두 세대를 묶기 위해서만 존재한다"* 는 계약을 갖는다 — 크래시로 잃을 뻔한
//! 편집을 되살리는 것이 전부이고, 그래서 `MAX_GENERATIONS_PER_DOCUMENT = 2` 로 잘라낸다. 거기에
//! 히스토리를 얹으면 두 목적이 서로를 갉는다: 히스토리를 남기려면 자르면 안 되고, 복구는 자르지
//! 않으면 무한히 자란다.
//!
//! 그래서 나란히 둔다. 같은 디렉터리 규율(비공개 0700 · 원자적 쓰기 · 총량 상한 · HWPX 바이트)을
//! 따르되 보존 정책만 다르다.
//!
//! ## 기록에 무엇이 없는가
//!
//! 복구본과 같이 **원본 경로도 문서 이름도 담지 않는다**. 무작위 `document_id` 가 버전들을 묶을 뿐이다.
//! 라벨은 사용자가 직접 쓴 것이라 저장하지만, 그것 역시 로그·이슈·아티팩트로 나가지 않는다.
//!
//! ## 고정(pin)
//!
//! 상한에 닿으면 오래된 것부터 지우되 **고정된 버전은 지우지 않는다**. "되돌아갈 지점" 이 조용히
//! 사라지면 이 기능은 없느니만 못하다 — 사람이 믿고 저장했는데 없어지는 것이 가장 나쁘다.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const VERSION_SCHEMA_VERSION: u32 = 1;
/// 한 문서가 가질 수 있는 **자동 정리 대상** 버전 수. 고정된 것은 이 수에 들어가지 않는다.
const MAX_UNPINNED_PER_DOCUMENT: usize = 50;
const DEFAULT_TOTAL_CAP: u64 = 512 * 1024 * 1024;
/// 사용자가 쓰는 라벨의 상한. 길이를 막지 않으면 메타데이터가 문서 본문을 담는 통로가 된다.
const MAX_LABEL_CHARS: usize = 80;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionMetadata {
    schema_version: u32,
    document_id: String,
    /// 문서 안에서 단조 증가. 파일 이름이자 정렬 키다.
    sequence: u64,
    revision: u64,
    saved_at_ms: u64,
    byte_len: u64,
    /// 사용자가 붙인 이름. 비어 있으면 UI 가 시각으로 대신 부른다.
    label: String,
    /// 자동 정리에서 보호한다.
    pinned: bool,
    /// 저장 시점의 쪽수 — 목록에서 "몇 쪽짜리였나" 를 보여 주려고 함께 남긴다. 0 = 모름.
    pages: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionSummary {
    pub(crate) document_id: String,
    pub(crate) sequence: u64,
    pub(crate) revision: u64,
    pub(crate) saved_at_ms: u64,
    pub(crate) byte_len: u64,
    pub(crate) label: String,
    pub(crate) pinned: bool,
    pub(crate) pages: u32,
}

impl From<&VersionMetadata> for VersionSummary {
    fn from(v: &VersionMetadata) -> Self {
        Self {
            document_id: v.document_id.clone(),
            sequence: v.sequence,
            revision: v.revision,
            saved_at_ms: v.saved_at_ms,
            byte_len: v.byte_len,
            label: v.label.clone(),
            pinned: v.pinned,
            pages: v.pages,
        }
    }
}

pub(crate) struct VersionStore {
    root: PathBuf,
    total_cap: u64,
}

impl VersionStore {
    pub(crate) fn new(app_data_dir: &Path) -> Result<Self, String> {
        Self::with_cap(app_data_dir, DEFAULT_TOTAL_CAP)
    }

    fn with_cap(app_data_dir: &Path, total_cap: u64) -> Result<Self, String> {
        let root = app_data_dir.join("versions-v1");
        create_private_dir(&root)?;
        Ok(Self { root, total_cap })
    }

    /// 버전 하나를 남긴다. 바이트는 공유 직렬화기가 만든 HWPX 여야 한다 — 다른 형식이 섞이면
    /// 되돌리기가 조용히 깨진다.
    pub(crate) fn save(
        &self,
        document_id: &str,
        revision: u64,
        saved_at_ms: u64,
        label: &str,
        pages: u32,
        bytes: &[u8],
    ) -> Result<VersionSummary, String> {
        validate_document_id(document_id)?;
        if bytes.len() < 4 || !bytes.starts_with(b"PK") {
            return Err("버전 바이트가 HWPX(ZIP)가 아니다".into());
        }
        if bytes.len() as u64 > self.total_cap {
            return Err("버전 하나가 총량 상한보다 크다".into());
        }
        let label = sanitize_label(label);
        let dir = self.root.join(document_id);
        create_private_dir(&dir)?;
        let sequence = self
            .records_for(document_id)?
            .iter()
            .map(|(m, _, _)| m.sequence)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let metadata = VersionMetadata {
            schema_version: VERSION_SCHEMA_VERSION,
            document_id: document_id.to_owned(),
            sequence,
            revision,
            saved_at_ms,
            byte_len: bytes.len() as u64,
            label,
            pinned: false,
            pages,
        };
        self.write_record(&dir, &metadata, Some(bytes))?;
        self.prune(document_id)?;
        Ok((&metadata).into())
    }

    /// 한 문서의 버전들 — **최신이 먼저**. 목록은 시간 역순으로 읽는 것이 자연스럽다.
    pub(crate) fn list(&self, document_id: &str) -> Result<Vec<VersionSummary>, String> {
        validate_document_id(document_id)?;
        let mut records = self.records_for(document_id)?;
        records.sort_by(|a, b| b.0.sequence.cmp(&a.0.sequence));
        Ok(records.iter().map(|(m, _, _)| m.into()).collect())
    }

    pub(crate) fn read(&self, document_id: &str, sequence: u64) -> Result<Vec<u8>, String> {
        validate_document_id(document_id)?;
        let (_, bytes_path, _) = self
            .records_for(document_id)?
            .into_iter()
            .find(|(m, _, _)| m.sequence == sequence)
            .ok_or_else(|| "그 버전이 없다".to_string())?;
        std::fs::read(&bytes_path).map_err(|e| format!("버전 바이트를 읽지 못했다: {e}"))
    }

    /// 고정 토글. 고정은 자동 정리로부터의 보호이지 삭제 금지가 아니다 — 사용자가 직접 지우는 것은
    /// 언제든 된다.
    pub(crate) fn set_pinned(
        &self,
        document_id: &str,
        sequence: u64,
        pinned: bool,
    ) -> Result<VersionSummary, String> {
        validate_document_id(document_id)?;
        let (mut metadata, _, meta_path) = self
            .records_for(document_id)?
            .into_iter()
            .find(|(m, _, _)| m.sequence == sequence)
            .ok_or_else(|| "그 버전이 없다".to_string())?;
        metadata.pinned = pinned;
        let encoded =
            serde_json::to_vec(&metadata).map_err(|e| format!("메타데이터 인코딩 실패: {e}"))?;
        hwp_core::atomic_write(&meta_path, &encoded)
            .map_err(|e| format!("메타데이터 쓰기 실패: {e}"))?;
        set_private_file(&meta_path)?;
        Ok((&metadata).into())
    }

    pub(crate) fn delete(&self, document_id: &str, sequence: u64) -> Result<(), String> {
        validate_document_id(document_id)?;
        let (_, bytes_path, meta_path) = self
            .records_for(document_id)?
            .into_iter()
            .find(|(m, _, _)| m.sequence == sequence)
            .ok_or_else(|| "그 버전이 없다".to_string())?;
        let _ = std::fs::remove_file(&bytes_path);
        let _ = std::fs::remove_file(&meta_path);
        Ok(())
    }

    fn write_record(
        &self,
        dir: &Path,
        metadata: &VersionMetadata,
        bytes: Option<&[u8]>,
    ) -> Result<(), String> {
        let stem = format!("version-{:020}", metadata.sequence);
        let bytes_path = dir.join(format!("{stem}.hwpx"));
        let meta_path = dir.join(format!("{stem}.json"));
        if let Some(bytes) = bytes {
            hwp_core::atomic_write(&bytes_path, bytes)
                .map_err(|e| format!("버전 바이트 쓰기 실패: {e}"))?;
        }
        let encoded =
            serde_json::to_vec(metadata).map_err(|e| format!("메타데이터 인코딩 실패: {e}"))?;
        if let Err(error) = hwp_core::atomic_write(&meta_path, &encoded) {
            // 메타데이터 없이 남은 바이트는 고아가 된다 — 둘 다 없는 편이 낫다.
            let _ = std::fs::remove_file(&bytes_path);
            return Err(format!("메타데이터 쓰기 실패: {error}"));
        }
        set_private_file(&bytes_path)?;
        set_private_file(&meta_path)?;
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    fn records_for(
        &self,
        document_id: &str,
    ) -> Result<Vec<(VersionMetadata, PathBuf, PathBuf)>, String> {
        let dir = self.root.join(document_id);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read(&path) else {
                continue;
            };
            // 읽을 수 없는 기록은 조용히 건너뛴다 — 하나가 깨졌다고 목록 전체를 잃으면 안 된다.
            let Ok(metadata) = serde_json::from_slice::<VersionMetadata>(&raw) else {
                continue;
            };
            if metadata.schema_version != VERSION_SCHEMA_VERSION
                || metadata.document_id != document_id
            {
                continue;
            }
            let bytes_path = path.with_extension("hwpx");
            if !bytes_path.is_file() {
                continue;
            }
            out.push((metadata, bytes_path, path));
        }
        Ok(out)
    }

    /// 상한 정리. **고정된 버전은 절대 지우지 않는다.**
    fn prune(&self, document_id: &str) -> Result<(), String> {
        let mut records = self.records_for(document_id)?;
        records.sort_by(|a, b| b.0.sequence.cmp(&a.0.sequence)); // 최신 먼저
        let mut unpinned_seen = 0usize;
        for (metadata, bytes_path, meta_path) in &records {
            if metadata.pinned {
                continue;
            }
            unpinned_seen += 1;
            if unpinned_seen > MAX_UNPINNED_PER_DOCUMENT {
                let _ = std::fs::remove_file(bytes_path);
                let _ = std::fs::remove_file(meta_path);
            }
        }
        Ok(())
    }
}

/// 라벨은 사용자 입력이다. 줄바꿈·제어문자를 지우고 길이를 막는다 — 메타데이터가 본문을 나르는
/// 통로가 되면 "기록에 문서 내용이 없다" 는 규율이 무너진다.
fn sanitize_label(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(MAX_LABEL_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// 복구본과 같은 규칙: 32자리 소문자 16진수. 경로 조작을 원천 차단한다.
fn validate_document_id(id: &str) -> Result<(), String> {
    if id.len() == 32
        && id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    {
        Ok(())
    } else {
        Err("문서 id 형식이 아니다".into())
    }
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("버전 디렉터리 생성 실패: {e}"))?;
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("버전 디렉터리 확인 실패: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("버전 디렉터리가 일반 디렉터리가 아니다".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("버전 디렉터리 권한 설정 실패: {e}"))?;
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("버전 파일 권한 설정 실패: {e}"))?;
    }
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static ID: AtomicU64 = AtomicU64::new(0);
    const DOC: &str = "00112233445566778899aabbccddeeff";

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "auto-hwp-versions-{}-{}",
                std::process::id(),
                ID.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn store(&self) -> VersionStore {
            VersionStore::new(&self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn hwpx(marker: u8) -> Vec<u8> {
        let mut v = b"PK\x03\x04".to_vec();
        v.push(marker);
        v
    }

    #[test]
    fn saves_lists_newest_first_and_reads_back_the_same_bytes() {
        let f = Fixture::new();
        let s = f.store();
        s.save(DOC, 1, 1_000, "첫 저장", 8, &hwpx(1)).unwrap();
        s.save(DOC, 2, 2_000, "", 9, &hwpx(2)).unwrap();

        let list = s.list(DOC).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].sequence, 2, "최신이 먼저");
        assert_eq!(list[0].pages, 9);
        assert_eq!(list[1].label, "첫 저장");
        assert_eq!(
            s.read(DOC, 1).unwrap(),
            hwpx(1),
            "되돌리기가 같은 바이트를 준다"
        );
    }

    #[test]
    fn pinned_versions_survive_the_cap() {
        let f = Fixture::new();
        let s = f.store();
        let keep = s
            .save(DOC, 1, 1_000, "지켜야 할 지점", 8, &hwpx(7))
            .unwrap();
        s.set_pinned(DOC, keep.sequence, true).unwrap();
        // 상한을 넘기도록 충분히 쌓는다.
        for i in 0..(MAX_UNPINNED_PER_DOCUMENT + 5) {
            s.save(DOC, i as u64 + 2, 2_000 + i as u64, "", 8, &hwpx(0))
                .unwrap();
        }
        let list = s.list(DOC).unwrap();
        assert!(
            list.iter().any(|v| v.sequence == keep.sequence && v.pinned),
            "고정한 버전이 정리에서 살아남아야 한다"
        );
        assert_eq!(
            s.read(DOC, keep.sequence).unwrap(),
            hwpx(7),
            "바이트도 함께 남아야 한다 — 메타데이터만 남으면 되돌릴 수 없다"
        );
        let unpinned = list.iter().filter(|v| !v.pinned).count();
        assert!(
            unpinned <= MAX_UNPINNED_PER_DOCUMENT,
            "고정 아닌 것은 상한 안으로 정리된다: {unpinned}"
        );
    }

    #[test]
    fn rejects_non_hwpx_bytes_and_bad_document_ids() {
        let f = Fixture::new();
        let s = f.store();
        assert!(s.save(DOC, 1, 1, "", 1, b"not a zip").is_err());
        assert!(s.save("../escape", 1, 1, "", 1, &hwpx(1)).is_err());
        assert!(s.save("SHORT", 1, 1, "", 1, &hwpx(1)).is_err());
    }

    #[test]
    fn labels_cannot_smuggle_control_characters_or_grow_without_bound() {
        let f = Fixture::new();
        let s = f.store();
        let nasty = format!("줄\n바꿈\t과 {}", "가".repeat(200));
        let saved = s.save(DOC, 1, 1, &nasty, 1, &hwpx(1)).unwrap();
        assert!(!saved.label.contains('\n') && !saved.label.contains('\t'));
        assert!(saved.label.chars().count() <= MAX_LABEL_CHARS);
    }

    #[test]
    fn a_document_with_no_versions_lists_empty_rather_than_failing() {
        let f = Fixture::new();
        assert!(f.store().list(DOC).unwrap().is_empty());
    }
}
