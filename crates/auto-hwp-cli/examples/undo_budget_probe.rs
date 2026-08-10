//! scratch(caret-undo 진단): N건 배치 적용 후 undo N회가 원문을 복원하는지 + 스냅샷 메모리 예산이
//! 언제 스냅샷을 축출하는지 실측.
//! 사용: cargo run -p auto-hwp-cli --features rhwp --example undo_budget_probe -- <path> [N]
use hwp_model::document::{Block, Inline};
use hwp_ops::{EditSession, Op, RunSpec};

fn doc_text(doc: &hwp_model::document::SemanticDoc) -> String {
    fn blocks(bs: &[Block], out: &mut String) {
        for b in bs {
            match b {
                Block::Paragraph(p) => {
                    for r in &p.runs {
                        for i in &r.content {
                            if let Inline::Text(t) = i {
                                out.push_str(t);
                            }
                        }
                    }
                    out.push('\n');
                }
                Block::Table(t) => {
                    for c in &t.cells {
                        blocks(&c.blocks, out);
                    }
                }
            }
        }
    }
    let mut s = String::new();
    for sec in &doc.sections {
        blocks(&sec.blocks, &mut s);
    }
    s
}

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let n: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(16);
    let bytes = std::fs::read(&path).unwrap();
    let doc = hwp_core::Engine::open(&bytes).unwrap();
    println!(
        "approx_heap_bytes = {} MB",
        doc.approx_heap_bytes() as f64 / 1e6
    );

    // 표 블록 하나를 찾는다(첫 번째 top-level Table).
    let (section, index, rows, cols) = {
        let mut found = None;
        for (si, sec) in doc.sections.iter().enumerate() {
            for (bi, b) in sec.blocks.iter().enumerate() {
                if let Block::Table(t) = b {
                    if t.rows * t.cols >= n {
                        found = Some((si, bi, t.rows, t.cols));
                        break;
                    }
                }
            }
            if found.is_some() {
                break;
            }
        }
        found.expect("표 없음")
    };
    println!("target table s{section}/b{index} {rows}x{cols}");

    let mut sess = EditSession::with_budget(doc, 50, 128 * 1024 * 1024);
    let before = doc_text(sess.doc());

    let mut applied = 0usize;
    'outer: for r in 0..rows {
        for c in 0..cols {
            if applied >= n {
                break 'outer;
            }
            let op = Op::SetTableCell {
                section,
                index,
                row: r,
                col: c,
                runs: vec![RunSpec {
                    text: "PoC ✔".into(),
                    ..Default::default()
                }],
            };
            if sess.do_op(&op).is_ok() {
                applied += 1;
            }
        }
    }
    println!("applied ops = {applied}, can_undo = {}", sess.can_undo());

    let mut undone = 0usize;
    for _ in 0..applied {
        if sess.undo() {
            undone += 1;
        }
    }
    let after = doc_text(sess.doc());
    println!("undone = {undone} / {applied}");
    println!("복원됨? {}", after == before);
    if after != before {
        let mut i = 0;
        let ab: Vec<char> = after.chars().collect();
        let bb: Vec<char> = before.chars().collect();
        while i < ab.len().min(bb.len()) && ab[i] == bb[i] {
            i += 1;
        }
        println!(
            "첫 불일치 {i}: before={:?} after={:?}",
            bb.iter().skip(i).take(30).collect::<String>(),
            ab.iter().skip(i).take(30).collect::<String>()
        );
    }
}
