use hwp_hwp5::{probe, Error, OwnHwp5Parser};

fn benchmark() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap()
}

#[test]
fn public_hwp5_has_bounded_content_free_record_provenance() {
    let parsed = probe(&benchmark()).unwrap();
    assert_eq!(parsed.inventory.sections, 1);
    assert!(parsed.inventory.paragraphs > 0);
    assert!(parsed.inventory.tables > 0);
    assert!(parsed
        .streams
        .iter()
        .flat_map(|stream| &stream.records)
        .all(|record| record.head <= record.data && record.data <= record.end));

    let json = serde_json::to_string(&parsed).unwrap();
    assert!(!json.contains("benchmark.hwp"));
    assert!(!json.contains("BodyText"));
    assert!(!json.contains("FileHeader"));
    assert!(json.contains("header_offset"));
}

#[test]
fn explicit_own_parser_never_falls_back() {
    let error = OwnHwp5Parser::new().parse(&benchmark()).unwrap_err();
    eprintln!("{error:?}");
    assert!(matches!(
        error,
        Error::UnsupportedBodyRecord {
            tag: 0x42,
            section: 0,
            start: 0,
            end: 28,
            reason: "multi-column break is not owned",
            ..
        }
    ));
}
