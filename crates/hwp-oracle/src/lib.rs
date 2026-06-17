//! Fidelity oracle. Shells out to LibreOffice (`soffice`) + the H2Orestart import
//! filter to render HWP/HWPX → PDF/PNG as a *reference*. GPL stays at arm's length:
//! out-of-process CLI only, never linked (docs/LICENSE-POLICY.md). Native only
//! (uses `std::process`), excluded from the wasm build.

use hwp_model::error::{Error, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Is a `soffice` binary discoverable?
pub fn soffice_available() -> bool {
    Command::new("soffice")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Best-effort detection of the H2Orestart LibreOffice extension (required to open
/// modern HWP v5 / HWPX — the native hwpfilter only handles HWP v3).
pub fn h2orestart_installed() -> bool {
    let out = Command::new("unopkg").arg("list").output();
    match out {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
            text.contains("h2orestart") || text.contains("hwp2002") || text.contains("ebandal")
        }
        Err(_) => false,
    }
}

/// Convert `input` (.hwp/.hwpx) to PDF in `out_dir` using LibreOffice headless.
/// Requires the H2Orestart extension for modern HWP v5/HWPX.
pub fn convert_to_pdf(input: &Path, out_dir: &Path) -> Result<PathBuf> {
    let status = Command::new("soffice")
        .args(["--headless", "--convert-to"])
        .arg("pdf")
        .arg("--outdir")
        .arg(out_dir)
        .arg(input)
        .status()
        .map_err(|e| Error::Io(format!("spawn soffice: {e}")))?;

    if !status.success() {
        return Err(Error::Other(format!(
            "soffice exited with {status} (is the H2Orestart extension installed for modern HWP?)"
        )));
    }

    let stem = input
        .file_stem()
        .ok_or_else(|| Error::Other("input has no file stem".into()))?;
    let pdf = out_dir.join(stem).with_extension("pdf");
    if !pdf.exists() {
        return Err(Error::Other(format!(
            "expected output not found: {}",
            pdf.display()
        )));
    }
    Ok(pdf)
}

/// Rasterize a PDF to one PNG per page via `pdftoppm` (poppler). Returns sorted paths.
pub fn pdf_to_pngs(pdf: &Path, out_dir: &Path, dpi: u32) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(out_dir).map_err(|e| Error::Io(e.to_string()))?;
    let prefix = out_dir.join("oracle");
    let status = Command::new("pdftoppm")
        .args(["-png", "-r", &dpi.to_string()])
        .arg(pdf)
        .arg(&prefix)
        .status()
        .map_err(|e| Error::Io(format!("spawn pdftoppm: {e}")))?;
    if !status.success() {
        return Err(Error::Other(format!("pdftoppm exited with {status}")));
    }
    let mut pngs: Vec<PathBuf> = std::fs::read_dir(out_dir)
        .map_err(|e| Error::Io(e.to_string()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().and_then(|s| s.to_str()) == Some("png")
                && p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.starts_with("oracle"))
                    .unwrap_or(false)
        })
        .collect();
    pngs.sort();
    Ok(pngs)
}

/// Rasterize one SVG to PNG via `rsvg-convert` (librsvg).
pub fn svg_to_png(svg: &Path, png: &Path, zoom: f64) -> Result<()> {
    let status = Command::new("rsvg-convert")
        .args(["-z", &format!("{zoom}")])
        .arg(svg)
        .arg("-o")
        .arg(png)
        .status()
        .map_err(|e| Error::Io(format!("spawn rsvg-convert: {e}")))?;
    if !status.success() {
        return Err(Error::Other(format!("rsvg-convert exited with {status}")));
    }
    Ok(())
}
