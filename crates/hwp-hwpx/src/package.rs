//! OPC/ZIP package reading. An HWPX is a ZIP with `mimetype` first (STORED).

use hwp_model::error::{Error, Result};
use std::io::{Cursor, Read};

/// A read view over an HWPX package.
pub struct Package {
    pub mimetype: Option<String>,
    pub part_names: Vec<String>,
    raw: Vec<u8>,
}

impl Package {
    /// Open from in-memory bytes.
    pub fn open(bytes: &[u8]) -> Result<Self> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
            .map_err(|e| Error::Parse(format!("zip open: {e}")))?;

        let mut part_names = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let f = zip
                .by_index(i)
                .map_err(|e| Error::Parse(format!("zip entry {i}: {e}")))?;
            part_names.push(f.name().to_string());
        }

        let mimetype = read_entry(&mut zip, "mimetype")
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string());

        Ok(Package {
            mimetype,
            part_names,
            raw: bytes.to_vec(),
        })
    }

    /// Read a single part's bytes by name.
    pub fn read_part(&self, name: &str) -> Result<Vec<u8>> {
        let mut zip = zip::ZipArchive::new(Cursor::new(self.raw.clone()))
            .map_err(|e| Error::Parse(format!("zip reopen: {e}")))?;
        read_entry(&mut zip, name)
    }

    /// The header part (`Contents/header.xml`) bytes, if present — holds the charPr/paraPr pools.
    pub fn read_header(&self) -> Option<Vec<u8>> {
        let name = self
            .part_names
            .iter()
            .find(|n| n.to_ascii_lowercase().ends_with("header.xml"))?;
        self.read_part(name).ok()
    }

    /// Names of body section parts: `Contents/section*.xml` (any case-insensitive dir).
    pub fn section_part_names(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .part_names
            .iter()
            .filter(|n| {
                let lower = n.to_ascii_lowercase();
                lower.ends_with(".xml")
                    && lower
                        .rsplit('/')
                        .next()
                        .map(|f| f.starts_with("section"))
                        .unwrap_or(false)
            })
            .cloned()
            .collect();
        v.sort();
        v
    }
}

fn read_entry<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>> {
    let mut f = zip
        .by_name(name)
        .map_err(|e| Error::Parse(format!("zip part '{name}': {e}")))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| Error::Io(format!("read part '{name}': {e}")))?;
    Ok(buf)
}
