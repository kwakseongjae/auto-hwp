//! scratch(caret-undo 진단): 표 블록의 중첩 구조 + 셀 문단 수를 덤프한다.
//! 사용: cargo run -p auto-hwp-cli --example nested_caret_probe -- <path> [needle]
use hwp_model::document::{Block, Inline};

fn para_text(p: &hwp_model::document::Paragraph) -> String {
    p.runs
        .iter()
        .flat_map(|r| r.content.iter())
        .map(|i| match i {
            Inline::Text(t) => t.clone(),
            _ => String::new(),
        })
        .collect()
}

fn dump_blocks(blocks: &[Block], depth: usize, path: &str, needle: &str) {
    let pad = "  ".repeat(depth);
    for (bi, b) in blocks.iter().enumerate() {
        match b {
            Block::Paragraph(p) => {
                let t = para_text(p);
                if needle.is_empty() || t.contains(needle) {
                    println!(
                        "{pad}{path}/b{bi} PARA {:?}",
                        t.chars().take(60).collect::<String>()
                    );
                }
            }
            Block::Table(tb) => {
                println!(
                    "{pad}{path}/b{bi} TABLE {}x{} cells={}",
                    tb.rows,
                    tb.cols,
                    tb.cells.len()
                );
                for c in &tb.cells {
                    let paras = c
                        .blocks
                        .iter()
                        .filter(|b| matches!(b, Block::Paragraph(_)))
                        .count();
                    let nested = c
                        .blocks
                        .iter()
                        .filter(|b| matches!(b, Block::Table(_)))
                        .count();
                    let joined: Vec<String> = c
                        .blocks
                        .iter()
                        .filter_map(|b| match b {
                            Block::Paragraph(p) => Some(para_text(p)),
                            _ => None,
                        })
                        .collect();
                    let text = joined.join(" ⏎ ");
                    let hit = needle.is_empty() || text.contains(needle);
                    if hit {
                        println!(
                            "{pad}  cell(r{},c{}) active={} paras={} nestedTables={} text={:?}",
                            c.row,
                            c.col,
                            c.active,
                            paras,
                            nested,
                            text.chars().take(80).collect::<String>()
                        );
                    }
                    if nested > 0 {
                        dump_blocks(
                            &c.blocks,
                            depth + 2,
                            &format!("{path}/b{bi}/r{}c{}", c.row, c.col),
                            needle,
                        );
                    }
                }
            }
        }
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let needle = std::env::args().nth(2).unwrap_or_default();
    let bytes = std::fs::read(&path).unwrap();
    let doc = hwp_core::Engine::open(&bytes).unwrap();
    for (si, sec) in doc.sections.iter().enumerate() {
        println!("== section {si} blocks={} ==", sec.blocks.len());
        dump_blocks(&sec.blocks, 0, &format!("s{si}"), &needle);
    }
}
