//! Shared scalar types and the round-trip-safety primitives.

/// Which on-disk format a document (or node) originated from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SourceFormat {
    /// HWP 5.0 binary (OLE/CFB compound file).
    Hwp5,
    /// HWP 3.0 legacy binary.
    Hwp3,
    /// HWPX (OWPML / KS X 6101, ZIP+XML).
    Hwpx,
    Unknown,
}

impl SourceFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceFormat::Hwp5 => "hwp5",
            SourceFormat::Hwp3 => "hwp3",
            SourceFormat::Hwpx => "hwpx",
            SourceFormat::Unknown => "unknown",
        }
    }
}

/// Stable identity for a node — addressing for undo/redo, AI ops, and diffing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(pub u64);

/// HWPUNIT: 1 inch = 7200 units, 1 pt = 100 units. Centralize all unit math on this.
pub type HwpUnit = i32;

/// Where a node came from, kept so untouched content can be written back verbatim.
#[derive(Clone, Debug, Default)]
pub struct Provenance {
    pub source: Option<SourceFormat>,
    /// Original bytes/XML for this node (verbatim re-emit on export if not dirty).
    pub raw: Option<Vec<u8>>,
}

/// Un-modeled content retained verbatim so round-trip never loses it.
/// This is the structural fix for the ecosystem's #1 bug (round-trip data loss):
/// "unknown element -> dropped" becomes "unknown element -> preserved but inert".
#[derive(Clone, Debug, Default)]
pub struct Passthrough {
    pub parts: Vec<RawPart>,
}

impl Passthrough {
    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }
    pub fn push(&mut self, tag: impl Into<String>, bytes: Vec<u8>) {
        self.parts.push(RawPart { tag: tag.into(), bytes });
    }
}

#[derive(Clone, Debug)]
pub struct RawPart {
    /// A label (element name / record tag) for diagnostics.
    pub tag: String,
    pub bytes: Vec<u8>,
}

/// Edit-state flag. Only dirty nodes are re-serialized; clean nodes round-trip verbatim.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dirty(pub bool);

impl Dirty {
    pub fn mark(&mut self) {
        self.0 = true;
    }
    pub fn is_dirty(self) -> bool {
        self.0
    }
}

/// sRGB color (used by char/para shapes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    /// Parse `#RRGGBB` (or `RRGGBB`) into an opaque color. None on malformed input.
    pub fn from_hex(s: &str) -> Option<Color> {
        let h = s.trim().trim_start_matches('#');
        if h.len() != 6 {
            return None;
        }
        Some(Color {
            r: u8::from_str_radix(&h[0..2], 16).ok()?,
            g: u8::from_str_radix(&h[2..4], 16).ok()?,
            b: u8::from_str_radix(&h[4..6], 16).ok()?,
            a: 255,
        })
    }

    /// `#RRGGBB`.
    pub fn to_hex(self) -> String {
        format!("#{:02X}{:02X}{:02X}", self.r, self.g, self.b)
    }
}
