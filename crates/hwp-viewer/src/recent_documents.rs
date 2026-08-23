//! Privacy-bounded recent-document persistence for issue #142.
//!
//! The store deliberately contains only a canonical local path and last-opened time. It never
//! receives document bytes, extracted text, hashes, thumbnails, recovery ids, or AI context.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u32 = 1;
const MAX_RECENT_DOCUMENTS: usize = 9;
const MAX_STORE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecentDocument {
    pub(crate) path: String,
    pub(crate) last_opened_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentStoreFile {
    schema_version: u32,
    entries: Vec<RecentDocument>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentDocumentListing {
    pub(crate) entries: Vec<RecentDocument>,
    pub(crate) warnings: Vec<String>,
}

pub(crate) struct RecentDocumentStore {
    root: PathBuf,
    file: PathBuf,
}

impl RecentDocumentStore {
    pub(crate) fn new(app_data_dir: &Path) -> Result<Self, String> {
        let root = app_data_dir.join("recent-documents-v1");
        create_private_dir(&root)?;
        let file = root.join("entries.json");
        Ok(Self { root, file })
    }

    pub(crate) fn list(&self) -> Result<RecentDocumentListing, String> {
        let (mut entries, warning) = self.load_or_reset()?;
        normalize_entries(&mut entries);
        Ok(RecentDocumentListing {
            entries,
            warnings: warning.into_iter().collect(),
        })
    }

    pub(crate) fn record(&self, canonical_path: &Path) -> Result<(), String> {
        self.record_at(canonical_path, now_ms())
    }

    fn record_at(&self, canonical_path: &Path, last_opened_ms: u64) -> Result<(), String> {
        let path = canonical_path
            .to_str()
            .ok_or("최근 문서 경로를 안전하게 저장할 수 없습니다")?
            .to_owned();
        let (mut entries, _) = self.load_or_reset()?;
        entries.retain(|entry| entry.path != path);
        entries.push(RecentDocument {
            path,
            last_opened_ms,
        });
        normalize_entries(&mut entries);
        self.write(&entries)
    }

    pub(crate) fn entry(&self, index: usize) -> Result<Option<RecentDocument>, String> {
        Ok(self.list()?.entries.get(index).cloned())
    }

    pub(crate) fn validated_open_path(&self, index: usize, cwd: &Path) -> Result<String, String> {
        let entry = self
            .entry(index)?
            .ok_or("최근 문서 항목을 찾을 수 없습니다")?;
        let mut paths = super::open_request::normalize_paths([PathBuf::from(entry.path)], cwd);
        if let Some(path) = paths.pop() {
            return Ok(path);
        }
        let _ = self.remove(index);
        Err("최근 문서를 열 수 없어 목록에서 제거했습니다".into())
    }

    pub(crate) fn remove(&self, index: usize) -> Result<RecentDocumentListing, String> {
        let mut listing = self.list()?;
        if index < listing.entries.len() {
            listing.entries.remove(index);
            self.write(&listing.entries)?;
        }
        Ok(listing)
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        reject_symlink(&self.file)?;
        match std::fs::remove_file(&self.file) {
            Ok(()) => sync_dir(&self.root),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("최근 문서 목록을 지우지 못했습니다".into()),
        }
    }

    fn load_or_reset(&self) -> Result<(Vec<RecentDocument>, Option<String>), String> {
        reject_symlink(&self.file)?;
        let bytes = match std::fs::read(&self.file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((Vec::new(), None));
            }
            Err(_) => return Err("최근 문서 목록을 읽지 못했습니다".into()),
        };
        if bytes.len() as u64 > MAX_STORE_BYTES {
            self.reset_corrupt()?;
            return Ok((
                Vec::new(),
                Some("손상된 최근 문서 목록을 비우고 안전하게 복구했습니다".into()),
            ));
        }
        let parsed: RecentStoreFile = match serde_json::from_slice(&bytes) {
            Ok(parsed) => parsed,
            Err(_) => {
                self.reset_corrupt()?;
                return Ok((
                    Vec::new(),
                    Some("손상된 최근 문서 목록을 비우고 안전하게 복구했습니다".into()),
                ));
            }
        };
        if parsed.schema_version != SCHEMA_VERSION {
            self.reset_corrupt()?;
            return Ok((
                Vec::new(),
                Some("호환되지 않는 최근 문서 목록을 비우고 안전하게 복구했습니다".into()),
            ));
        }
        Ok((parsed.entries, None))
    }

    fn reset_corrupt(&self) -> Result<(), String> {
        reject_symlink(&self.file)?;
        match std::fs::remove_file(&self.file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("손상된 최근 문서 목록을 초기화하지 못했습니다".into()),
        }
        sync_dir(&self.root)
    }

    fn write(&self, entries: &[RecentDocument]) -> Result<(), String> {
        let payload = RecentStoreFile {
            schema_version: SCHEMA_VERSION,
            entries: entries.to_vec(),
        };
        let bytes =
            serde_json::to_vec(&payload).map_err(|_| "최근 문서 목록을 인코딩하지 못했습니다")?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err("최근 문서 목록의 안전한 크기 제한을 초과했습니다".into());
        }
        reject_symlink(&self.file)?;
        hwp_core::atomic_write(&self.file, &bytes)
            .map_err(|_| "최근 문서 목록을 저장하지 못했습니다")?;
        set_private_file(&self.file)?;
        sync_dir(&self.root)
    }
}

fn normalize_entries(entries: &mut Vec<RecentDocument>) {
    entries.retain(|entry| {
        !entry.path.is_empty()
            && Path::new(&entry.path).is_absolute()
            && super::open_request::supported_path(Path::new(&entry.path))
    });
    entries.sort_by(|left, right| {
        right
            .last_opened_ms
            .cmp(&left.last_opened_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut seen = std::collections::HashSet::new();
    entries.retain(|entry| seen.insert(entry.path.clone()));
    entries.truncate(MAX_RECENT_DOCUMENTS);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("최근 문서 저장소 경로가 안전하지 않습니다".into());
        }
    } else {
        std::fs::create_dir_all(path).map_err(|_| "최근 문서 저장소를 만들지 못했습니다")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "최근 문서 저장소 권한을 제한하지 못했습니다")?;
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "최근 문서 목록 권한을 제한하지 못했습니다")?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("최근 문서 목록 경로가 안전하지 않습니다".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("최근 문서 목록 경로를 확인하지 못했습니다".into()),
    }
}

fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|_| "최근 문서 저장소 동기화에 실패했습니다")?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "auto-hwp-recent-documents-{}-{id}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn document(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, b"fixture").unwrap();
            std::fs::canonicalize(path).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn keeps_nine_newest_and_moves_a_reopened_document_to_the_front() {
        let fixture = Fixture::new();
        let store = RecentDocumentStore::new(&fixture.0).unwrap();
        let documents: Vec<_> = (0..11)
            .map(|index| fixture.document(&format!("{index}.hwpx")))
            .collect();
        for (index, path) in documents.iter().enumerate() {
            store.record_at(path, index as u64).unwrap();
        }
        let listing = store.list().unwrap();
        assert_eq!(listing.entries.len(), MAX_RECENT_DOCUMENTS);
        assert!(listing.entries[0].path.ends_with("10.hwpx"));
        assert!(!listing.entries.iter().any(|entry| {
            Path::new(&entry.path)
                .file_name()
                .and_then(|name| name.to_str())
                == Some("0.hwpx")
        }));

        store.record_at(&documents[5], 99).unwrap();
        let listing = store.list().unwrap();
        assert!(listing.entries[0].path.ends_with("5.hwpx"));
        assert_eq!(
            listing
                .entries
                .iter()
                .filter(|entry| entry.path.ends_with("5.hwpx"))
                .count(),
            1
        );
    }

    #[test]
    fn persisted_entries_contain_only_path_and_last_opened_time() {
        let fixture = Fixture::new();
        let store = RecentDocumentStore::new(&fixture.0).unwrap();
        store
            .record_at(&fixture.document("public.hwp"), 42)
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&store.file).unwrap()).unwrap();
        let entry = value["entries"][0].as_object().unwrap();
        let mut keys: Vec<_> = entry.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["lastOpenedMs", "path"]);
        let raw = String::from_utf8(std::fs::read(&store.file).unwrap()).unwrap();
        for forbidden in ["content", "text", "hash", "thumbnail", "aiContext"] {
            assert!(!raw.contains(forbidden));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&store.root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&store.file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn corrupted_and_incompatible_stores_reset_with_visible_path_free_warnings() {
        let fixture = Fixture::new();
        let store = RecentDocumentStore::new(&fixture.0).unwrap();
        std::fs::write(&store.file, b"not-json").unwrap();
        let listing = store.list().unwrap();
        assert!(listing.entries.is_empty());
        assert_eq!(listing.warnings.len(), 1);
        assert!(!listing.warnings[0].contains(fixture.0.to_str().unwrap()));

        std::fs::write(&store.file, br#"{"schemaVersion":999,"entries":[]}"#).unwrap();
        let listing = store.list().unwrap();
        assert!(listing.entries.is_empty());
        assert_eq!(listing.warnings.len(), 1);
    }

    #[test]
    fn remove_and_clear_are_bounded_and_idempotent() {
        let fixture = Fixture::new();
        let store = RecentDocumentStore::new(&fixture.0).unwrap();
        store.record_at(&fixture.document("a.hwp"), 1).unwrap();
        store.record_at(&fixture.document("b.hwpx"), 2).unwrap();
        assert_eq!(store.remove(0).unwrap().entries.len(), 1);
        assert_eq!(store.remove(99).unwrap().entries.len(), 1);
        store.clear().unwrap();
        store.clear().unwrap();
        assert!(store.list().unwrap().entries.is_empty());
    }

    #[test]
    fn missing_or_renamed_document_is_pruned_before_reopen() {
        let fixture = Fixture::new();
        let store = RecentDocumentStore::new(&fixture.0).unwrap();
        let document = fixture.document("moved.hwpx");
        store.record_at(&document, 1).unwrap();
        std::fs::remove_file(&document).unwrap();
        assert!(store.validated_open_path(0, &fixture.0).is_err());
        assert!(store.list().unwrap().entries.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_store_root() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let target = fixture.0.join("target");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, fixture.0.join("recent-documents-v1")).unwrap();
        assert!(RecentDocumentStore::new(&fixture.0).is_err());
    }
}
