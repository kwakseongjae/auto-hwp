//! Desktop file-open intake for issue #140.
//!
//! The OS can request a document before the webview subscribes (cold launch), through a second
//! process (warm launch), or through a platform opened-URL event. Keep that OS plumbing outside the
//! document engine: validate local paths, queue a bounded set, and let the shared workspace consume
//! them through the existing `open_doc` command.

use std::collections::{HashSet, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A single-window shell can only present a small number of explicit replacement confirmations.
/// The bound also prevents an attacker-controlled argv/event batch from growing resident state.
const MAX_PENDING_OPEN_REQUESTS: usize = 8;

#[derive(Clone, Default)]
pub(crate) struct OpenRequestQueue(Arc<Mutex<VecDeque<String>>>);

impl OpenRequestQueue {
    /// Append validated paths without duplicating a request already waiting in the queue.
    pub(crate) fn push(&self, paths: impl IntoIterator<Item = String>) -> usize {
        let Ok(mut queue) = self.0.lock() else {
            return 0;
        };
        let mut known: HashSet<String> = queue.iter().cloned().collect();
        let before = queue.len();
        for path in paths {
            if queue.len() >= MAX_PENDING_OPEN_REQUESTS {
                break;
            }
            if known.insert(path.clone()) {
                queue.push_back(path);
            }
        }
        queue.len() - before
    }

    pub(crate) fn take(&self) -> Vec<String> {
        let Ok(mut queue) = self.0.lock() else {
            return Vec::new();
        };
        queue.drain(..).collect()
    }
}

pub(crate) fn supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("hwp") || ext.eq_ignore_ascii_case("hwpx"))
}

/// Resolve candidates and verify that the current process can open them for reading, without
/// consuming document bytes. Canonicalizing here deduplicates relative paths and symlink aliases;
/// the engine still performs all container and format validation.
pub(crate) fn normalize_paths(
    candidates: impl IntoIterator<Item = PathBuf>,
    cwd: &Path,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut accepted = Vec::new();

    for candidate in candidates {
        if accepted.len() >= MAX_PENDING_OPEN_REQUESTS || !supported_path(&candidate) {
            continue;
        }
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            cwd.join(candidate)
        };
        let Ok(canonical) = std::fs::canonicalize(resolved) else {
            continue;
        };
        let Ok(metadata) = std::fs::metadata(&canonical) else {
            continue;
        };
        if !metadata.is_file()
            || !supported_path(&canonical)
            || std::fs::File::open(&canonical).is_err()
        {
            continue;
        }
        let Some(path) = canonical.to_str().map(str::to_owned) else {
            continue;
        };
        if seen.insert(path.clone()) {
            accepted.push(path);
        }
    }
    accepted
}

/// Process command-line arguments from an initial or second desktop instance. Argument zero is the
/// executable; all other values are treated strictly as filesystem paths, never URLs or commands.
pub(crate) fn paths_from_argv<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    normalize_paths(
        args.into_iter()
            .skip(1)
            .map(|arg| PathBuf::from(arg.into())),
        cwd,
    )
}

/// Platform `RunEvent::Opened` values are URLs. Accept only `file:` URLs that convert to local paths;
/// custom/http schemes never reach the filesystem intake.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn paths_from_urls(urls: &[tauri::Url], cwd: &Path) -> Vec<String> {
    normalize_paths(
        urls.iter()
            .filter(|url| url.scheme() == "file")
            .filter_map(|url| url.to_file_path().ok()),
        cwd,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("auto-hwp-open-request-{}-{id}", std::process::id()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }

        fn file(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            std::fs::write(&path, b"fixture").unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn argv_skips_executable_resolves_relative_paths_and_deduplicates() {
        let fixture = Fixture::new();
        let expected = fixture.file("public.hwpx");
        let paths = paths_from_argv(
            [
                OsString::from("auto-hwp"),
                OsString::from("public.hwpx"),
                expected.as_os_str().to_owned(),
            ],
            &fixture.root,
        );
        assert_eq!(
            paths,
            vec![std::fs::canonicalize(expected).unwrap().to_str().unwrap()]
        );
    }

    #[test]
    fn rejects_missing_directories_and_unsupported_extensions() {
        let fixture = Fixture::new();
        let text = fixture.file("notes.txt");
        let folder = fixture.root.join("folder.hwp");
        std::fs::create_dir(&folder).unwrap();
        let paths = normalize_paths(
            [text, folder, fixture.root.join("missing.hwpx")],
            &fixture.root,
        );
        assert!(paths.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_document_after_read_permission_is_lost() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let document = fixture.file("private.hwpx");
        std::fs::set_permissions(&document, std::fs::Permissions::from_mode(0o000)).unwrap();
        let paths = normalize_paths([document.clone()], &fixture.root);
        std::fs::set_permissions(&document, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(paths.is_empty());
    }

    #[test]
    fn accepts_only_local_file_urls() {
        let fixture = Fixture::new();
        let doc = fixture.file("opened.HWP");
        let file_url = tauri::Url::from_file_path(&doc).unwrap();
        let https_url = tauri::Url::parse("https://example.test/document.hwpx").unwrap();
        let custom_url = tauri::Url::parse("auto-hwp://open/document.hwpx").unwrap();
        let paths = paths_from_urls(&[file_url, https_url, custom_url], &fixture.root);
        assert_eq!(
            paths,
            vec![std::fs::canonicalize(doc).unwrap().to_str().unwrap()]
        );
    }

    #[test]
    fn candidate_and_queue_sizes_are_bounded() {
        let fixture = Fixture::new();
        let candidates: Vec<_> = (0..20)
            .map(|index| fixture.file(&format!("{index}.hwpx")))
            .collect();
        let paths = normalize_paths(candidates, &fixture.root);
        assert_eq!(paths.len(), MAX_PENDING_OPEN_REQUESTS);

        let queue = OpenRequestQueue::default();
        assert_eq!(queue.push(paths.clone()), MAX_PENDING_OPEN_REQUESTS);
        assert_eq!(queue.push(paths), 0, "duplicates do not grow the queue");
        assert_eq!(queue.take().len(), MAX_PENDING_OPEN_REQUESTS);
        assert!(
            queue.take().is_empty(),
            "take drains the queue exactly once"
        );
    }
}
