//! Desktop document lifecycle state for issue #141.
//!
//! This state deliberately separates the in-memory source identity (needed to detect an external
//! overwrite race) from recovery metadata persisted under app-data. Source paths never leave this
//! process through the recovery store, events, logs, or telemetry.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceIdentity {
    canonical_path: PathBuf,
    len: u64,
    modified_ns: u128,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl SourceIdentity {
    fn read(path: &Path) -> Result<Self, String> {
        let canonical_path =
            std::fs::canonicalize(path).map_err(|e| format!("source identity unavailable: {e}"))?;
        let metadata = std::fs::metadata(&canonical_path)
            .map_err(|e| format!("source identity unavailable: {e}"))?;
        if !metadata.is_file() {
            return Err("source identity unavailable: not a regular file".into());
        }
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            canonical_path,
            len: metadata.len(),
            modified_ns,
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }

    fn same_target(&self, path: &Path) -> bool {
        std::fs::canonicalize(path).is_ok_and(|candidate| candidate == self.canonical_path)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSessionStatus {
    pub(crate) document_id: Option<String>,
    pub(crate) revision: u64,
    pub(crate) saved_revision: u64,
    pub(crate) dirty: bool,
    pub(crate) has_source: bool,
}

#[derive(Default)]
pub(crate) struct DesktopDocumentState {
    document_id: Option<String>,
    saved_revision: u64,
    source: Option<SourceIdentity>,
    unsaved: bool,
    recovery_suppressed: bool,
    allow_close_once: bool,
}

impl DesktopDocumentState {
    pub(crate) fn opened_path(&mut self, path: &Path, revision: u64) -> Result<(), String> {
        self.document_id = Some(new_document_id()?);
        self.saved_revision = revision;
        self.source = Some(SourceIdentity::read(path)?);
        self.unsaved = false;
        self.recovery_suppressed = false;
        self.allow_close_once = false;
        Ok(())
    }

    pub(crate) fn opened_recovery(&mut self, revision: u64) -> Result<(), String> {
        self.document_id = Some(new_document_id()?);
        self.saved_revision = revision;
        self.source = None;
        self.unsaved = true;
        self.recovery_suppressed = false;
        self.allow_close_once = false;
        Ok(())
    }

    pub(crate) fn status(&self, revision: u64) -> DesktopSessionStatus {
        DesktopSessionStatus {
            document_id: self.document_id.clone(),
            revision,
            saved_revision: self.saved_revision,
            dirty: self.document_id.is_some() && (self.unsaved || revision != self.saved_revision),
            has_source: self.source.is_some(),
        }
    }

    /// Return `true` only when the user is saving back over the originally-opened path and its
    /// identity changed since open/last successful save. A Save As destination is not an external
    /// conflict; after it succeeds, `mark_saved` adopts it as the new source identity.
    pub(crate) fn external_conflict(&self, destination: &Path) -> Result<bool, String> {
        let Some(opened) = &self.source else {
            return Ok(false);
        };
        if !destination.exists() || !opened.same_target(destination) {
            return Ok(false);
        }
        Ok(SourceIdentity::read(destination)? != *opened)
    }

    pub(crate) fn mark_saved(&mut self, destination: &Path, revision: u64) -> Result<(), String> {
        self.source = Some(SourceIdentity::read(destination)?);
        self.saved_revision = revision;
        self.unsaved = false;
        self.recovery_suppressed = false;
        Ok(())
    }

    pub(crate) fn should_write_recovery(&self, revision: u64) -> bool {
        !self.recovery_suppressed && self.status(revision).dirty
    }

    pub(crate) fn suppress_recovery_for(&mut self, document_id: &str) {
        if self.document_id.as_deref() == Some(document_id) {
            self.recovery_suppressed = true;
        }
    }

    pub(crate) fn document_id(&self) -> Option<&str> {
        self.document_id.as_deref()
    }

    pub(crate) fn should_prevent_close(&mut self, revision: u64) -> bool {
        if self.allow_close_once {
            self.allow_close_once = false;
            return false;
        }
        self.status(revision).dirty
    }

    pub(crate) fn allow_close_once(&mut self) {
        self.allow_close_once = true;
    }
}

fn new_document_id() -> Result<String, String> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|e| format!("document id generation failed: {e}"))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
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
                "auto-hwp-desktop-state-{}-{id}",
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

    #[test]
    fn revision_dirty_signal_tracks_successful_save() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source.hwpx");
        std::fs::write(&source, b"first").unwrap();
        let mut state = DesktopDocumentState::default();
        state.opened_path(&source, 0).unwrap();
        assert!(!state.status(0).dirty);
        assert!(state.status(1).dirty);
        state.mark_saved(&source, 1).unwrap();
        assert!(!state.status(1).dirty);
        assert!(state.status(2).dirty);
    }

    #[test]
    fn external_source_change_blocks_only_same_destination() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source.hwpx");
        let save_as = fixture.0.join("copy.hwpx");
        std::fs::write(&source, b"first").unwrap();
        std::fs::write(&save_as, b"copy").unwrap();
        let mut state = DesktopDocumentState::default();
        state.opened_path(&source, 0).unwrap();
        assert!(!state.external_conflict(&source).unwrap());

        // A size change is deterministic even on filesystems with coarse mtime resolution.
        std::fs::write(&source, b"externally changed").unwrap();
        assert!(state.external_conflict(&source).unwrap());
        assert!(!state.external_conflict(&save_as).unwrap());
    }

    #[test]
    fn restored_session_is_unsaved_and_path_free() {
        let mut state = DesktopDocumentState::default();
        state.opened_recovery(0).unwrap();
        let status = state.status(0);
        assert!(!status.has_source);
        assert!(status.dirty, "a restored session has no source save point");
        assert!(status.document_id.is_some());
    }

    #[test]
    fn dirty_close_is_prevented_until_one_explicit_bypass() {
        let mut state = DesktopDocumentState::default();
        state.opened_recovery(0).unwrap();
        assert!(state.should_prevent_close(1));
        state.allow_close_once();
        assert!(!state.should_prevent_close(1));
        assert!(state.should_prevent_close(1));
    }

    #[test]
    fn explicit_discard_suppresses_a_racing_snapshot_until_save_or_reopen() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source.hwpx");
        std::fs::write(&source, b"first").unwrap();
        let mut state = DesktopDocumentState::default();
        state.opened_path(&source, 0).unwrap();
        let document_id = state.document_id().unwrap().to_owned();
        assert!(state.should_write_recovery(1));
        state.suppress_recovery_for(&document_id);
        assert!(!state.should_write_recovery(1));
        state.mark_saved(&source, 1).unwrap();
        assert!(state.should_write_recovery(2));
    }
}
