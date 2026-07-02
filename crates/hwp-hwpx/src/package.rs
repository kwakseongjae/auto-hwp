//! OPC/ZIP package reading. An HWPX is a ZIP with `mimetype` first (STORED).
//!
//! HARDENING (issue #014): every inflate is **byte-counted** against
//! [`limits::MAX_DECOMPRESSED_TOTAL`] — we never trust an entry's declared `size()` (an attacker
//! forges it), so a single high-ratio deflate stream (the realistic zip bomb; the zip crate is
//! deflate-only) is stopped at the cap instead of exhausting memory. The legacy [`Package::open`] /
//! [`Package::read_part`] path is protected too (mapping the typed limit into the crate's flat
//! `Error` so the live app is safe today), while [`Package::open_guarded`] surfaces the typed
//! [`limits::DocLimit`] for the future service (013).

use hwp_ingest::limits::{self, DocLimit, HardenedError};
use hwp_model::error::{Error, Result};
use std::cell::Cell;
use std::io::{Cursor, Read};

/// A read view over an HWPX package.
pub struct Package {
    pub mimetype: Option<String>,
    pub part_names: Vec<String>,
    raw: Vec<u8>,
    /// Remaining decompression budget (bytes) shared across every part read of this package, so the
    /// cap is **cumulative** across `read_part` calls, not merely per-entry. Initialised to
    /// [`limits::MAX_DECOMPRESSED_TOTAL`]. `Cell` because `read_part` is `&self`.
    budget: Cell<u64>,
}

/// Per-part read failure, before mapping to either the legacy `Error` or the typed `HardenedError`.
enum PartError {
    /// A resource limit tripped (decompressed budget exhausted).
    Limit(DocLimit),
    /// The entry is missing / the archive is malformed / an IO error occurred mid-inflate.
    Malformed(String),
}

impl Package {
    /// Open from in-memory bytes (legacy path — used by the live app via `hwp_core::Engine`).
    /// Hardened in place: raw-size + entry-count checks, and every part read is byte-capped. Limit
    /// failures are surfaced as `Error::Parse`/`Error::Io` (the crate's flat error) so existing
    /// callers keep working; the **typed** limit lives on [`Package::open_guarded`].
    pub fn open(bytes: &[u8]) -> Result<Self> {
        limits::check_raw_size(bytes.len()).map_err(limit_to_error)?;

        let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
            .map_err(|e| Error::Parse(format!("zip open: {e}")))?;
        // The zip crate reads the central directory eagerly in `new`, so `len()` is trustworthy here.
        limits::check_entry_count(zip.len()).map_err(limit_to_error)?;

        let mut part_names = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let f = zip
                .by_index(i)
                .map_err(|e| Error::Parse(format!("zip entry {i}: {e}")))?;
            part_names.push(f.name().to_string());
        }

        let mut budget = limits::MAX_DECOMPRESSED_TOTAL;
        let mimetype = Self::read_entry(&mut zip, "mimetype", &mut budget)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string());

        Ok(Package {
            mimetype,
            part_names,
            raw: bytes.to_vec(),
            budget: Cell::new(budget),
        })
    }

    /// Hardened open for untrusted input (the service path — 013 wires it). Identical parsing to
    /// [`Package::open`] but returns the **typed** [`HardenedError`] so a caller can switch on
    /// `HardenedError::Limit(DocLimit::…)` vs `HardenedError::Malformed(_)`.
    pub fn open_guarded(bytes: &[u8]) -> std::result::Result<Self, HardenedError> {
        limits::check_raw_size(bytes.len())?;

        let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
            .map_err(|e| HardenedError::Malformed(format!("zip open: {e}")))?;
        limits::check_entry_count(zip.len())?;

        let mut part_names = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let f = zip
                .by_index(i)
                .map_err(|e| HardenedError::Malformed(format!("zip entry {i}: {e}")))?;
            part_names.push(f.name().to_string());
        }

        let mut budget = limits::MAX_DECOMPRESSED_TOTAL;
        // mimetype is a tiny STORED entry (~19 bytes); reading it here consumes a negligible slice of
        // the budget and any malformation is tolerated (mimetype is optional in our model).
        let mimetype = Self::read_entry(&mut zip, "mimetype", &mut budget)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string());

        Ok(Package {
            mimetype,
            part_names,
            raw: bytes.to_vec(),
            budget: Cell::new(budget),
        })
    }

    /// Read a single part's bytes by name (legacy path). Decrements the shared cumulative budget.
    pub fn read_part(&self, name: &str) -> Result<Vec<u8>> {
        self.read_part_inner(name).map_err(part_to_error)
    }

    /// Read a single part's bytes by name (typed path — decrements the shared cumulative budget and
    /// surfaces [`HardenedError`]).
    pub fn read_part_guarded(&self, name: &str) -> std::result::Result<Vec<u8>, HardenedError> {
        self.read_part_inner(name).map_err(part_to_hardened)
    }

    fn read_part_inner(&self, name: &str) -> std::result::Result<Vec<u8>, PartError> {
        let mut zip = zip::ZipArchive::new(Cursor::new(self.raw.clone()))
            .map_err(|e| PartError::Malformed(format!("zip reopen: {e}")))?;
        let mut budget = self.budget.get();
        let out = Self::read_entry(&mut zip, name, &mut budget);
        self.budget.set(budget);
        out
    }

    /// The header part (`Contents/header.xml`) bytes, if present — holds the charPr/paraPr pools.
    pub fn read_header(&self) -> Option<Vec<u8>> {
        let name = self.header_part_name()?;
        self.read_part(&name).ok()
    }

    /// Name of the header part (`…header.xml`), if any.
    pub fn header_part_name(&self) -> Option<String> {
        self.part_names
            .iter()
            .find(|n| n.to_ascii_lowercase().ends_with("header.xml"))
            .cloned()
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

    /// Inflate one entry, counting the **actual** decompressed bytes against `budget` (never the
    /// declared `size()`). Reads at most `budget + 1` bytes: the moment the stream would exceed the
    /// remaining budget we stop and reject, so a deflate bomb cannot allocate past the cap. `budget`
    /// is decremented by the bytes consumed so the caller can thread a cumulative total.
    fn read_entry<R: Read + std::io::Seek>(
        zip: &mut zip::ZipArchive<R>,
        name: &str,
        budget: &mut u64,
    ) -> std::result::Result<Vec<u8>, PartError> {
        let f = zip
            .by_name(name)
            .map_err(|e| PartError::Malformed(format!("zip part '{name}': {e}")))?;
        // take(budget+1): if inflation would produce more than the remaining budget, read_to_end
        // stops at budget+1 bytes and we reject — bounded memory, no OOM.
        let cap = budget.saturating_add(1);
        let mut buf = Vec::new();
        f.take(cap)
            .read_to_end(&mut buf)
            .map_err(|e| PartError::Malformed(format!("read part '{name}': {e}")))?;
        let produced = buf.len() as u64;
        if produced > *budget {
            return Err(PartError::Limit(DocLimit::DecompressedTooLarge {
                limit: limits::MAX_DECOMPRESSED_TOTAL,
            }));
        }
        *budget -= produced;
        Ok(buf)
    }
}

fn limit_to_error(l: DocLimit) -> Error {
    Error::Parse(format!("hwpx input rejected: {l}"))
}

fn part_to_error(e: PartError) -> Error {
    match e {
        PartError::Limit(l) => Error::Parse(format!("hwpx input rejected: {l}")),
        PartError::Malformed(s) => Error::Io(s),
    }
}

fn part_to_hardened(e: PartError) -> HardenedError {
    match e {
        PartError::Limit(l) => HardenedError::Limit(l),
        PartError::Malformed(s) => HardenedError::Malformed(s),
    }
}
