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
fn explicit_own_parser_owns_bounded_control_host_terminator_shape_then_stops_content_free() {
    let probed = probe(&benchmark()).unwrap();
    let next = probed
        .streams
        .iter()
        .flat_map(|stream| &stream.records)
        .find(|record| record.head == 45_487)
        .unwrap();
    assert_eq!(
        (next.tag, next.level, next.head, next.data, next.end, next.size,),
        (0x48, 2, 45_487, 45_491, 45_538, 47)
    );
    let error = OwnHwp5Parser::new().parse(&benchmark()).unwrap_err();
    eprintln!("{error:?}");
    assert!(matches!(
        error,
        Error::MalformedRecord {
            tag: 0x48,
            section: Some(0),
            offset: 45487,
            reason: "cell LIST_HEADER count, direction, alignment, or width reference is not owned",
            ..
        }
    ));
}
