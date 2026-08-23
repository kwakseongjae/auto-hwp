//! Private, bounded desktop recovery snapshots for issue #141.
//!
//! Recovery records intentionally contain no source path or document name. The random document id
//! exists only to group two generations. Bytes are always HWPX produced by the shared serializer.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const RECOVERY_SCHEMA_VERSION: u32 = 1;
const MAX_GENERATIONS_PER_DOCUMENT: usize = 2;
const DEFAULT_TOTAL_CAP: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotMetadata {
    schema_version: u32,
    document_id: String,
    generation: u64,
    revision: u64,
    saved_at_ms: u64,
    byte_len: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoverySummary {
    pub(crate) document_id: String,
    pub(crate) generation: u64,
    pub(crate) revision: u64,
    pub(crate) saved_at_ms: u64,
    pub(crate) byte_len: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryListing {
    pub(crate) records: Vec<RecoverySummary>,
    pub(crate) warnings: Vec<String>,
}

impl From<&SnapshotMetadata> for RecoverySummary {
    fn from(value: &SnapshotMetadata) -> Self {
        Self {
            document_id: value.document_id.clone(),
            generation: value.generation,
            revision: value.revision,
            saved_at_ms: value.saved_at_ms,
            byte_len: value.byte_len,
        }
    }
}

pub(crate) struct RecoveryStore {
    root: PathBuf,
    total_cap: u64,
}

impl RecoveryStore {
    pub(crate) fn new(app_data_dir: &Path) -> Result<Self, String> {
        Self::with_cap(app_data_dir, DEFAULT_TOTAL_CAP)
    }

    fn with_cap(app_data_dir: &Path, total_cap: u64) -> Result<Self, String> {
        let root = app_data_dir.join("recovery-v1");
        create_private_dir(&root)?;
        Ok(Self { root, total_cap })
    }

    pub(crate) fn write(
        &self,
        document_id: &str,
        revision: u64,
        saved_at_ms: u64,
        bytes: &[u8],
    ) -> Result<RecoverySummary, String> {
        validate_document_id(document_id)?;
        if bytes.len() < 4 || !bytes.starts_with(b"PK") {
            return Err("recovery snapshot is not an HWPX ZIP".into());
        }
        if bytes.len() as u64 > self.total_cap {
            return Err("recovery snapshot exceeds the total size cap".into());
        }
        let dir = self.root.join(document_id);
        create_private_dir(&dir)?;
        let existing = self.records_for(document_id)?;
        let generation = existing
            .iter()
            .map(|(meta, _, _)| meta.generation)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let metadata = SnapshotMetadata {
            schema_version: RECOVERY_SCHEMA_VERSION,
            document_id: document_id.to_owned(),
            generation,
            revision,
            saved_at_ms,
            byte_len: bytes.len() as u64,
        };
        let stem = format!("snapshot-{generation:020}");
        let bytes_path = dir.join(format!("{stem}.hwpx"));
        let meta_path = dir.join(format!("{stem}.json"));
        hwp_core::atomic_write(&bytes_path, bytes)
            .map_err(|e| format!("recovery bytes write failed: {e}"))?;
        let metadata_bytes = serde_json::to_vec(&metadata)
            .map_err(|e| format!("recovery metadata encode failed: {e}"))?;
        if let Err(error) = hwp_core::atomic_write(&meta_path, &metadata_bytes) {
            let _ = std::fs::remove_file(&bytes_path);
            return Err(format!("recovery metadata write failed: {error}"));
        }
        set_private_file(&bytes_path)?;
        set_private_file(&meta_path)?;
        self.prune(Some((document_id, generation)))?;
        Ok((&metadata).into())
    }

    pub(crate) fn list(&self) -> Result<Vec<RecoverySummary>, String> {
        let mut records = self.all_records()?;
        records.sort_by(|a, b| snapshot_order(&a.0, &b.0));
        records.reverse();
        Ok(records.iter().map(|(meta, _, _)| meta.into()).collect())
    }

    pub(crate) fn list_with_warnings(&self) -> Result<RecoveryListing, String> {
        let records = self.list()?;
        let quarantined = count_quarantined(&self.root)?;
        let warnings = if quarantined == 0 {
            Vec::new()
        } else {
            vec![format!(
                "손상되었거나 호환되지 않는 복구 파일 {quarantined}건을 로컬 격리했습니다"
            )]
        };
        Ok(RecoveryListing { records, warnings })
    }

    pub(crate) fn read(&self, document_id: &str, generation: u64) -> Result<Vec<u8>, String> {
        validate_document_id(document_id)?;
        let record = self
            .records_for(document_id)?
            .into_iter()
            .find(|(meta, _, _)| meta.generation == generation)
            .ok_or("recovery snapshot not found")?;
        let bytes =
            std::fs::read(&record.1).map_err(|e| format!("recovery snapshot read failed: {e}"))?;
        if bytes.len() as u64 != record.0.byte_len || !bytes.starts_with(b"PK") {
            self.quarantine_pair(&record.1, &record.2)?;
            return Err("recovery snapshot is corrupt and was quarantined".into());
        }
        Ok(bytes)
    }

    pub(crate) fn discard_document(&self, document_id: &str) -> Result<(), String> {
        validate_document_id(document_id)?;
        let dir = self.root.join(document_id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("recovery discard failed: {e}"))?;
        }
        Ok(())
    }

    fn prune(&self, preserve: Option<(&str, u64)>) -> Result<(), String> {
        let mut records = self.all_records()?;
        records.sort_by(|a, b| snapshot_order(&a.0, &b.0));

        let mut per_document = std::collections::HashMap::<String, Vec<usize>>::new();
        for (index, (meta, _, _)) in records.iter().enumerate() {
            per_document
                .entry(meta.document_id.clone())
                .or_default()
                .push(index);
        }
        let mut remove = std::collections::HashSet::new();
        for indexes in per_document.values() {
            let excess = indexes.len().saturating_sub(MAX_GENERATIONS_PER_DOCUMENT);
            remove.extend(
                indexes
                    .iter()
                    .copied()
                    .filter(|index| {
                        !preserve.is_some_and(|(document_id, generation)| {
                            records[*index].0.document_id == document_id
                                && records[*index].0.generation == generation
                        })
                    })
                    .take(excess),
            );
        }

        let mut total: u64 = records
            .iter()
            .enumerate()
            .filter(|(index, _)| !remove.contains(index))
            .map(|(_, (meta, _, _))| meta.byte_len)
            .sum();
        for (index, (meta, _, _)) in records.iter().enumerate() {
            if total <= self.total_cap {
                break;
            }
            if preserve.is_some_and(|(document_id, generation)| {
                meta.document_id == document_id && meta.generation == generation
            }) {
                continue;
            }
            if remove.insert(index) {
                total = total.saturating_sub(meta.byte_len);
            }
        }
        for index in remove {
            let (_, bytes_path, meta_path) = &records[index];
            remove_pair(bytes_path, meta_path)?;
        }
        Ok(())
    }

    fn all_records(&self) -> Result<Vec<(SnapshotMetadata, PathBuf, PathBuf)>, String> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.root)
            .map_err(|e| format!("recovery directory read failed: {e}"))?
        {
            let entry = entry.map_err(|e| format!("recovery directory entry failed: {e}"))?;
            if !entry.path().is_dir() {
                continue;
            }
            let Some(document_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_document_id(&document_id).is_err() {
                continue;
            }
            out.extend(self.records_for(&document_id)?);
        }
        Ok(out)
    }

    fn records_for(
        &self,
        document_id: &str,
    ) -> Result<Vec<(SnapshotMetadata, PathBuf, PathBuf)>, String> {
        let dir = self.root.join(document_id);
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)
            .map_err(|e| format!("recovery document directory read failed: {e}"))?
        {
            let entry = entry.map_err(|e| format!("recovery entry failed: {e}"))?;
            let meta_path = entry.path();
            if meta_path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let parsed = std::fs::read(&meta_path)
                .map_err(|e| format!("recovery metadata read failed: {e}"))
                .and_then(|bytes| {
                    serde_json::from_slice::<SnapshotMetadata>(&bytes)
                        .map_err(|e| format!("recovery metadata is incompatible: {e}"))
                });
            let Ok(meta) = parsed else {
                let quarantine = meta_path.with_extension("json.quarantine");
                let _ = std::fs::rename(&meta_path, quarantine);
                continue;
            };
            if meta.schema_version != RECOVERY_SCHEMA_VERSION || meta.document_id != document_id {
                let quarantine = meta_path.with_extension("json.quarantine");
                let _ = std::fs::rename(&meta_path, quarantine);
                continue;
            }
            let bytes_path = meta_path.with_extension("hwpx");
            if !bytes_path.is_file() {
                let quarantine = meta_path.with_extension("json.quarantine");
                let _ = std::fs::rename(&meta_path, quarantine);
                continue;
            }
            out.push((meta, bytes_path, meta_path));
        }
        Ok(out)
    }

    fn quarantine_pair(&self, bytes_path: &Path, meta_path: &Path) -> Result<(), String> {
        let document_id = bytes_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .ok_or("recovery quarantine document id unavailable")?;
        validate_document_id(document_id)?;
        let quarantine = self.root.join("quarantine").join(document_id);
        create_private_dir(&quarantine)?;
        for path in [bytes_path, meta_path] {
            if path.exists() {
                let Some(name) = path.file_name() else {
                    continue;
                };
                let target = quarantine.join(format!("{}.quarantine", name.to_string_lossy()));
                std::fs::rename(path, target)
                    .map_err(|e| format!("recovery quarantine failed: {e}"))?;
            }
        }
        Ok(())
    }
}

fn validate_document_id(document_id: &str) -> Result<(), String> {
    if document_id.len() != 32
        || !document_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("invalid recovery document id".into());
    }
    Ok(())
}

fn snapshot_order(a: &SnapshotMetadata, b: &SnapshotMetadata) -> std::cmp::Ordering {
    (a.saved_at_ms, &a.document_id, a.generation).cmp(&(
        b.saved_at_ms,
        &b.document_id,
        b.generation,
    ))
}

fn remove_pair(bytes_path: &Path, meta_path: &Path) -> Result<(), String> {
    for path in [bytes_path, meta_path] {
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("recovery prune failed: {e}"))?;
        }
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("recovery directory create failed: {e}"))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("recovery directory metadata failed: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("recovery directory is not a private regular directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("recovery directory permissions failed: {e}"))?;
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("recovery file permissions failed: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn count_quarantined(root: &Path) -> Result<usize, String> {
    fn walk(path: &Path, count: &mut usize) -> Result<(), String> {
        for entry in
            std::fs::read_dir(path).map_err(|e| format!("recovery quarantine scan failed: {e}"))?
        {
            let entry = entry.map_err(|e| format!("recovery quarantine entry failed: {e}"))?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count)?;
            } else if path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension == "quarantine")
                || path
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|value| value.to_str())
                    == Some("quarantine")
            {
                *count += 1;
            }
        }
        Ok(())
    }
    let mut count = 0;
    walk(root, &mut count)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
    const DOC_A: &str = "00112233445566778899aabbccddeeff";
    const DOC_B: &str = "ffeeddccbbaa99887766554433221100";

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "auto-hwp-recovery-store-{}-{id}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn hwpx(fill: u8, len: usize) -> Vec<u8> {
        let mut bytes = vec![fill; len.max(4)];
        bytes[0..4].copy_from_slice(b"PK\x03\x04");
        bytes
    }

    #[test]
    fn retains_two_generations_and_latest_first() {
        let fixture = Fixture::new();
        let store = RecoveryStore::with_cap(&fixture.0, 1_000).unwrap();
        store.write(DOC_A, 1, 100, &hwpx(1, 20)).unwrap();
        store.write(DOC_A, 2, 200, &hwpx(2, 20)).unwrap();
        store.write(DOC_A, 3, 300, &hwpx(3, 20)).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].revision, 3);
        assert_eq!(list[1].revision, 2);
        assert_eq!(store.read(DOC_A, list[0].generation).unwrap(), hwpx(3, 20));
    }

    #[test]
    fn total_cap_prunes_oldest_deterministically() {
        let fixture = Fixture::new();
        let store = RecoveryStore::with_cap(&fixture.0, 30).unwrap();
        store.write(DOC_A, 1, 100, &hwpx(1, 20)).unwrap();
        store.write(DOC_B, 1, 200, &hwpx(2, 20)).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].document_id, DOC_B);
    }

    #[test]
    fn clock_rollback_never_prunes_the_snapshot_just_reported_as_saved() {
        let fixture = Fixture::new();
        let store = RecoveryStore::with_cap(&fixture.0, 30).unwrap();
        store.write(DOC_A, 1, 200, &hwpx(1, 20)).unwrap();
        let newest_write = store.write(DOC_B, 1, 100, &hwpx(2, 20)).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].document_id, newest_write.document_id);
    }

    #[test]
    fn corrupt_bytes_are_quarantined_without_touching_other_records() {
        let fixture = Fixture::new();
        let store = RecoveryStore::with_cap(&fixture.0, 1_000).unwrap();
        let first = store.write(DOC_A, 1, 100, &hwpx(1, 20)).unwrap();
        store.write(DOC_B, 1, 200, &hwpx(2, 20)).unwrap();
        let bad = store
            .root
            .join(DOC_A)
            .join(format!("snapshot-{:020}.hwpx", first.generation));
        std::fs::write(&bad, b"bad").unwrap();
        assert!(store.read(DOC_A, first.generation).is_err());
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.list().unwrap()[0].document_id, DOC_B);
    }

    #[test]
    fn metadata_is_path_free_and_discard_is_scoped() {
        let fixture = Fixture::new();
        let store = RecoveryStore::with_cap(&fixture.0, 1_000).unwrap();
        store.write(DOC_A, 1, 100, &hwpx(1, 20)).unwrap();
        store.write(DOC_B, 1, 200, &hwpx(2, 20)).unwrap();
        let metadata = std::fs::read_to_string(
            store
                .root
                .join(DOC_A)
                .join("snapshot-00000000000000000001.json"),
        )
        .unwrap();
        assert!(!metadata.contains("path"));
        assert!(!metadata.contains("name"));
        store.discard_document(DOC_A).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].document_id, DOC_B);
    }

    #[test]
    fn incompatible_metadata_is_quarantined_and_reported_without_hiding_valid_records() {
        let fixture = Fixture::new();
        let store = RecoveryStore::with_cap(&fixture.0, 1_000).unwrap();
        store.write(DOC_A, 1, 100, &hwpx(1, 20)).unwrap();
        let invalid_dir = store.root.join(DOC_B);
        create_private_dir(&invalid_dir).unwrap();
        std::fs::write(
            invalid_dir.join("snapshot-00000000000000000001.json"),
            b"{}",
        )
        .unwrap();
        let listing = store.list_with_warnings().unwrap();
        assert_eq!(listing.records.len(), 1);
        assert_eq!(listing.warnings.len(), 1);
        assert!(listing.warnings[0].contains("격리"));
    }

    #[cfg(unix)]
    #[test]
    fn recovery_root_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let outside = fixture.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, fixture.0.join("recovery-v1")).unwrap();
        assert!(RecoveryStore::with_cap(&fixture.0, 1_000).is_err());
    }

    #[test]
    fn corrupt_records_from_two_documents_quarantine_without_name_collision() {
        let fixture = Fixture::new();
        let store = RecoveryStore::with_cap(&fixture.0, 1_000).unwrap();
        let first = store.write(DOC_A, 1, 100, &hwpx(1, 20)).unwrap();
        let second = store.write(DOC_B, 1, 200, &hwpx(2, 20)).unwrap();
        for (document_id, generation) in [
            (first.document_id.as_str(), first.generation),
            (second.document_id.as_str(), second.generation),
        ] {
            let bytes = store
                .root
                .join(document_id)
                .join(format!("snapshot-{generation:020}.hwpx"));
            std::fs::write(bytes, b"bad").unwrap();
            assert!(store.read(document_id, generation).is_err());
        }
        let listing = store.list_with_warnings().unwrap();
        assert!(listing.records.is_empty());
        assert_eq!(listing.warnings.len(), 1);
    }
}
