#![cfg(feature = "rhwp")]

use hwp_core::hwp5_own_parser_eligibility;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn public_hwp5_cases() -> Vec<PathBuf> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(repo.join("corpus/hwp"))
        .expect("committed public HWP5 corpus exists")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "hwp"))
        .collect();
    paths.push(repo.join("benchmarks/benchmark.hwp"));
    let private_intake = repo.join("corpus/private/public-intake/files");
    if let Ok(entries) = std::fs::read_dir(private_intake) {
        paths.extend(
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|extension| extension == "hwp")),
        );
    }
    paths.sort();
    paths
}

#[test]
fn public_hwp5_matrix_is_reproducible_content_free_and_fail_closed() {
    let cases = public_hwp5_cases();
    assert!(
        cases.len() >= 13,
        "public HWP5 coverage unexpectedly shrank"
    );

    let mut eligible = 0usize;
    let mut rejected = BTreeMap::<&'static str, usize>::new();
    for path in &cases {
        let bytes = std::fs::read(path).expect("committed public case remains readable");
        let first = hwp5_own_parser_eligibility(&bytes).expect("bounded diagnostic completes");
        let second = hwp5_own_parser_eligibility(&bytes).expect("bounded diagnostic repeats");
        assert_eq!(first, second, "eligibility must be deterministic");

        if first.eligible {
            eligible += 1;
            let comparison = first
                .comparison
                .as_ref()
                .expect("eligible case has comparison");
            assert!(comparison.mismatches.is_empty());
            assert!(comparison.topology_matches);
            assert!(comparison.text_matches);
        } else {
            let code = first
                .rejection_code
                .expect("every ineligible case has a static reason");
            *rejected.entry(code).or_default() += 1;
        }

        let public = serde_json::to_string(&first).unwrap();
        assert!(!public.contains(&path.to_string_lossy().to_string()));
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            assert!(!public.contains(name));
        }
    }

    println!(
        "hwp5-eligibility-matrix.v2 cases={} eligible={} ineligible={} reasons={rejected:?}",
        cases.len(),
        eligible,
        cases.len() - eligible,
    );
}
