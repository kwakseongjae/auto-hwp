//! 진단 하네스(이슈 6): 웹(wasm) 화면 경로 vs PDF export 경로의 폰트/메트릭 분기를 실측한다.
//! `cargo run -p auto-hwp-cli --features "rhwp,shaper,pdf" --example font_divergence <doc.hwp> <outdir>`
//!
//! 화면(wasm): `own_render_fonts_with(&[("Nanum Gothic", bytes), ("Nanum Myeongjo", bytes)])`
//! PDF (wasm): `emit_pdf_with_fonts` 내부는 `own_render_fonts()` — wasm 에는 fs 폰트가 없어 Approx.
//! wasm 을 흉내내기 위해 여기서는 Approx(=wasm 의 own_render_fonts 결과)와 RealFontMetrics::from_bytes 를
//! 직접 비교한다.
use hwp_model::prelude::FontMetricsProvider;
use std::path::PathBuf;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: font_divergence <file.hwp>");
    let bytes = std::fs::read(&path).expect("read doc");
    let doc = hwp_core::Engine::open(&bytes).expect("open");

    let gothic = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../assets/fonts/NanumGothic-Regular.ttf"
    ))
    .unwrap();
    let myeongjo = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../assets/fonts/NanumMyeongjo-Regular.ttf"
    ))
    .unwrap();
    let injected: Vec<(String, Vec<u8>)> = vec![
        ("Nanum Gothic".into(), gothic.clone()),
        ("Nanum Myeongjo".into(), myeongjo.clone()),
    ];

    // A) 화면(wasm) 메트릭: 주입 바이트 + WithFamilies
    let screen = hwp_session::own_render_fonts_with(&injected);
    // B) PDF(wasm) 메트릭: fs 없음 → Approx, families 없음
    let pdf_web: Box<dyn FontMetricsProvider> = Box::new(hwp_typeset::ApproxFontMetrics);

    let pa = hwp_typeset::place_doc(&doc, screen.as_ref());
    let pb = hwp_typeset::place_doc(&doc, pdf_web.as_ref());
    println!(
        "[pages] screen(real bytes) = {}  vs  pdf-on-web(Approx) = {}",
        pa.pages.len(),
        pb.pages.len()
    );

    let ta = hwp_render::render_doc_trees(&doc, screen.as_ref());
    let tb = hwp_render::render_doc_trees(&doc, pdf_web.as_ref());
    println!(
        "[trees] screen = {} pages, pdf-on-web = {} pages",
        ta.len(),
        tb.len()
    );

    // 글리프 x좌표/폰트 태그 비교(첫 페이지)
    let glyphs = |t: &hwp_model::layout::PageLayerTree| -> Vec<(f64, f64, char, Option<String>)> {
        t.ops
            .iter()
            .filter_map(|op| match op {
                hwp_model::layout::PaintOp::Glyph { x, y, ch, font, .. } => {
                    Some((*x, *y, *ch, font.clone()))
                }
                _ => None,
            })
            .collect()
    };
    if let (Some(a0), Some(b0)) = (ta.first(), tb.first()) {
        let ga = glyphs(a0);
        let gb = glyphs(b0);
        println!(
            "[p1 glyphs] screen = {}, pdf-on-web = {}",
            ga.len(),
            gb.len()
        );
        let n = ga.len().min(gb.len());
        let mut first_diff = None;
        let mut maxdx: f64 = 0.0;
        for i in 0..n {
            let dx = (ga[i].0 - gb[i].0).abs();
            if dx > maxdx {
                maxdx = dx;
            }
            if first_diff.is_none() && (ga[i].2 != gb[i].2 || dx > 1.0) {
                first_diff = Some(i);
            }
        }
        println!(
            "[p1] 최대 x 편차 = {maxdx:.1} HWPUNIT ({:.2} pt), 첫 불일치 index = {:?}",
            maxdx / 100.0,
            first_diff
        );
        if let Some(i) = first_diff {
            println!("   screen[{i}] = {:?}", ga[i]);
            println!("   pdf   [{i}] = {:?}", gb[i]);
        }
        // 폰트 태그 분포
        let dist = |g: &Vec<(f64, f64, char, Option<String>)>| {
            let mut m = std::collections::BTreeMap::<String, usize>::new();
            for x in g {
                *m.entry(x.3.clone().unwrap_or_else(|| "<default gothic>".into()))
                    .or_default() += 1;
            }
            m
        };
        println!("[p1 font tags] screen = {:?}", dist(&ga));
        println!("[p1 font tags] pdf    = {:?}", dist(&gb));
    }

    // 전체 문서 폰트 태그 분포(모든 페이지)
    let all = |ts: &Vec<hwp_model::layout::PageLayerTree>| {
        let mut m = std::collections::BTreeMap::<String, usize>::new();
        for t in ts {
            for op in &t.ops {
                if let hwp_model::layout::PaintOp::Glyph { font, .. } = op {
                    *m.entry(font.clone().unwrap_or_else(|| "<default gothic>".into()))
                        .or_default() += 1;
                }
            }
        }
        m
    };
    println!("[all font tags] screen = {:?}", all(&ta));
    println!("[all font tags] pdf    = {:?}", all(&tb));

    // 볼드/이탤릭 런 실측 + 페이지별 줄(고유 baseline) 수 비교
    let bold_count = |ts: &Vec<hwp_model::layout::PageLayerTree>| {
        ts.iter()
            .flat_map(|t| t.ops.iter())
            .filter(|op| matches!(op, hwp_model::layout::PaintOp::Glyph { bold: true, .. }))
            .count()
    };
    println!(
        "[bold glyphs] screen = {}, pdf = {}",
        bold_count(&ta),
        bold_count(&tb)
    );
    for (i, (a, b)) in ta.iter().zip(tb.iter()).enumerate() {
        let lines = |t: &hwp_model::layout::PageLayerTree| {
            let mut s = std::collections::BTreeSet::<i64>::new();
            for op in &t.ops {
                if let hwp_model::layout::PaintOp::Glyph { y, .. } = op {
                    s.insert(*y as i64);
                }
            }
            s.len()
        };
        let ga = a
            .ops
            .iter()
            .filter(|o| matches!(o, hwp_model::layout::PaintOp::Glyph { .. }))
            .count();
        let gb = b
            .ops
            .iter()
            .filter(|o| matches!(o, hwp_model::layout::PaintOp::Glyph { .. }))
            .count();
        println!(
            "  p{}: glyphs {ga} vs {gb} · lines(고유 baseline) {} vs {}",
            i + 1,
            lines(a),
            lines(b)
        );
    }

    // 실제 PDF 두 벌 — (1) 현행(웹) 재현: Approx 메트릭 + 주입 폰트, (2) 기대: 주입 메트릭 + 주입 폰트
    let outdir = PathBuf::from(std::env::args().nth(2).unwrap_or_else(|| "/tmp".into()));
    let cur = hwp_export::pdf::export_pdf_with_fonts(
        &doc,
        pdf_web.as_ref(),
        &hwp_export::pdf::PdfOptions { title: None },
        &injected,
    )
    .unwrap();
    std::fs::write(outdir.join("pdf-current-web.pdf"), &cur.bytes).unwrap();
    // 수리 후 앱이 실제로 등록하는 세트: 고딕 Regular(=메트릭 backing) + 고딕 Bold + 명조 + 명조 Bold
    let gothic_bold = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../assets/fonts/NanumGothic-Bold.ttf"
    ))
    .unwrap();
    let myeongjo_bold = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../assets/fonts/NanumMyeongjo-Bold.ttf"
    ))
    .unwrap();
    let injected_fixed: Vec<(String, Vec<u8>)> = vec![
        ("Nanum Gothic".into(), gothic),
        ("Nanum Gothic Bold".into(), gothic_bold),
        ("Nanum Myeongjo".into(), myeongjo),
        ("Nanum Myeongjo Bold".into(), myeongjo_bold),
    ];
    let want = hwp_export::pdf::export_pdf_with_fonts(
        &doc,
        screen.as_ref(),
        &hwp_export::pdf::PdfOptions { title: None },
        &injected_fixed,
    )
    .unwrap();
    std::fs::write(outdir.join("pdf-fixed-web.pdf"), &want.bytes).unwrap();
    println!(
        "current(web repro): {} pages, {} KB, font={:?}",
        cur.pages,
        cur.bytes.len() / 1024,
        cur.font_path
    );
    println!(
        "fixed  (expected) : {} pages, {} KB, font={:?}",
        want.pages,
        want.bytes.len() / 1024,
        want.font_path
    );

    // 화면 SVG(1쪽) 저장 — 육안 대조용
    let svgs = hwp_session::render_svg_with(&doc, &injected);
    for (i, s) in svgs.iter().enumerate().take(4) {
        std::fs::write(outdir.join(format!("screen-p{}.svg", i + 1)), s).unwrap();
    }
    println!("screen svg pages = {}", svgs.len());
}
