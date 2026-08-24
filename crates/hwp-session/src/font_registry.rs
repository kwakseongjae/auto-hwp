//! Deterministic host-fed font registry and path/text-free realization evidence.

use std::collections::{BTreeMap, BTreeSet};

use hwp_model::document::{Block, Inline, Paragraph};
use hwp_model::font_class::{classify, FontCategory};
use hwp_model::prelude::{ScriptClass, SemanticDoc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DEFAULT_MAX_FACES: usize = 32;
pub const DEFAULT_MAX_FACE_BYTES: usize = 24 * 1024 * 1024;
pub const DEFAULT_MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FontStyle {
    Regular,
    Bold,
    Italic,
    BoldItalic,
}

impl FontStyle {
    pub fn from_flags(bold: bool, italic: bool) -> Self {
        match (bold, italic) {
            (false, false) => Self::Regular,
            (true, false) => Self::Bold,
            (false, true) => Self::Italic,
            (true, true) => Self::BoldItalic,
        }
    }

    fn decorated_family(self, family: &str) -> String {
        match self {
            Self::Regular => family.to_string(),
            Self::Bold => format!("{family} Bold"),
            Self::Italic => format!("{family} Italic"),
            Self::BoldItalic => format!("{family} Bold Italic"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FontRegistryLimits {
    pub max_faces: usize,
    pub max_face_bytes: usize,
    pub max_total_bytes: usize,
}

impl Default for FontRegistryLimits {
    fn default() -> Self {
        Self {
            max_faces: DEFAULT_MAX_FACES,
            max_face_bytes: DEFAULT_MAX_FACE_BYTES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FontFaceInput {
    pub family: String,
    pub style: FontStyle,
    pub bytes: Vec<u8>,
    pub face_index: u32,
}

impl FontFaceInput {
    /// Convert the legacy `(family label, bytes)` web injection seam into the typed contract. Style
    /// suffixes are normalized so `Family` + `Family Bold` become one family with two distinct faces.
    pub fn from_legacy_label(family: String, bytes: Vec<u8>) -> Self {
        let (family, style) = split_legacy_style(&family);
        Self {
            family,
            style,
            bytes,
            face_index: 0,
        }
    }
}

#[derive(Clone, Debug)]
struct RegisteredFace {
    family: String,
    normalized_family: String,
    style: FontStyle,
    bytes: Vec<u8>,
    sha256: String,
    category: FontCategory,
}

#[derive(Clone, Debug)]
pub struct FontRegistry {
    faces: Vec<RegisteredFace>,
    fingerprint: String,
}

impl FontRegistry {
    pub fn new(inputs: Vec<FontFaceInput>, limits: FontRegistryLimits) -> Result<Self, String> {
        if inputs.is_empty() {
            return Err("font registry must contain at least one face".into());
        }
        if inputs.len() > limits.max_faces {
            return Err(format!(
                "font registry face limit exceeded ({})",
                limits.max_faces
            ));
        }
        let mut total = 0usize;
        let mut seen = BTreeSet::new();
        let mut faces = Vec::with_capacity(inputs.len());
        for input in inputs {
            let family = input.family.trim();
            if family.is_empty() || family.len() > 128 || family.chars().any(char::is_control) {
                return Err("font family must be 1..128 non-control characters".into());
            }
            if input.face_index != 0 {
                return Err("only finite face_index 0 is supported".into());
            }
            if input.bytes.len() > limits.max_face_bytes {
                return Err(format!(
                    "font face byte limit exceeded ({})",
                    limits.max_face_bytes
                ));
            }
            total = total
                .checked_add(input.bytes.len())
                .ok_or_else(|| "font registry byte total overflow".to_string())?;
            if total > limits.max_total_bytes {
                return Err(format!(
                    "font registry total byte limit exceeded ({})",
                    limits.max_total_bytes
                ));
            }
            validate_single_face(&input.bytes)?;
            let normalized_family = normalize_family(family);
            if !seen.insert((normalized_family.clone(), input.style)) {
                return Err("duplicate font family/style".into());
            }
            faces.push(RegisteredFace {
                family: family.to_string(),
                normalized_family,
                style: input.style,
                sha256: hex_sha256(&input.bytes),
                category: classify(family),
                bytes: input.bytes,
            });
        }
        faces.sort_by(|a, b| {
            (&a.normalized_family, a.style, &a.sha256).cmp(&(
                &b.normalized_family,
                b.style,
                &b.sha256,
            ))
        });
        let mut digest = Sha256::new();
        digest.update(b"auto-hwp-font-registry-v1\0");
        for face in &faces {
            digest.update(face.normalized_family.as_bytes());
            digest.update([face.style as u8]);
            digest.update(face.sha256.as_bytes());
        }
        let fingerprint = format!("sha256:{}", hex_bytes(&digest.finalize()));
        Ok(Self { faces, fingerprint })
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn injected_faces(&self) -> Vec<(String, Vec<u8>)> {
        self.faces
            .iter()
            .map(|face| {
                (
                    face.style.decorated_family(&face.family),
                    face.bytes.clone(),
                )
            })
            .collect()
    }

    pub fn realization_report(&self, doc: &SemanticDoc) -> FontRealizationReport {
        type Key = (String, FontStyle, RealizationStatus, Option<String>);
        let mut aggregate: BTreeMap<Key, u64> = BTreeMap::new();
        for section in &doc.sections {
            visit_blocks(&section.blocks, &mut |paragraph| {
                for run in &paragraph.runs {
                    let shape = doc.char_shapes.get(run.char_shape);
                    let style = FontStyle::from_flags(
                        shape.is_some_and(|value| value.bold),
                        shape.is_some_and(|value| value.italic),
                    );
                    for inline in &run.content {
                        let Inline::Text(text) = inline else { continue };
                        for ch in text.chars().filter(|ch| !ch.is_whitespace()) {
                            let requested = shape.and_then(|value| {
                                value
                                    .fonts
                                    .get(script_slot(ch) as usize)
                                    .and_then(|name| name.as_deref())
                                    .or(value.font_family.as_deref())
                                    .map(str::trim)
                                    .filter(|name| !name.is_empty())
                            });
                            let category = requested.map(classify).unwrap_or(FontCategory::Other);
                            let selected = self.select(requested, category, style);
                            let (status, hash) = match selected {
                                Some((face, true)) => {
                                    (RealizationStatus::Exact, Some(face.sha256.clone()))
                                }
                                Some((face, false)) => {
                                    (RealizationStatus::Fallback, Some(face.sha256.clone()))
                                }
                                None => (RealizationStatus::Unavailable, None),
                            };
                            *aggregate
                                .entry((category_name(category).to_string(), style, status, hash))
                                .or_default() += 1;
                        }
                    }
                }
            });
        }
        FontRealizationReport {
            schema_version: 1,
            registry_fingerprint: self.fingerprint.clone(),
            face_count: self.faces.len(),
            lanes: aggregate
                .into_iter()
                .map(
                    |((requested_category, style, status, selected_face_sha256), glyph_count)| {
                        FontRealizationLane {
                            requested_category,
                            style,
                            status,
                            selected_face_sha256,
                            glyph_count,
                        }
                    },
                )
                .collect(),
        }
    }

    fn select(
        &self,
        requested: Option<&str>,
        category: FontCategory,
        style: FontStyle,
    ) -> Option<(&RegisteredFace, bool)> {
        if let Some(requested) = requested {
            let family = normalize_family(requested);
            if let Some(face) = self
                .faces
                .iter()
                .find(|face| face.normalized_family == family && face.style == style)
            {
                return Some((face, true));
            }
            if let Some(face) = self
                .faces
                .iter()
                .find(|face| face.normalized_family == family && face.style == FontStyle::Regular)
            {
                return Some((face, false));
            }
        }
        let fallback_category = match category {
            FontCategory::Other => FontCategory::Gothic,
            value => value,
        };
        let fallback = self
            .faces
            .iter()
            .find(|face| face.category == fallback_category && face.style == style)
            .or_else(|| {
                self.faces.iter().find(|face| {
                    face.category == fallback_category && face.style == FontStyle::Regular
                })
            });
        fallback
            .or_else(|| requested.is_none().then(|| self.faces.first()).flatten())
            .map(|face| (face, false))
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RealizationStatus {
    Exact,
    Fallback,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct FontRealizationReport {
    pub schema_version: u32,
    pub registry_fingerprint: String,
    pub face_count: usize,
    pub lanes: Vec<FontRealizationLane>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct FontRealizationLane {
    pub requested_category: String,
    pub style: FontStyle,
    pub status: RealizationStatus,
    pub selected_face_sha256: Option<String>,
    pub glyph_count: u64,
}

fn visit_blocks(blocks: &[Block], visit: &mut impl FnMut(&Paragraph)) {
    for block in blocks {
        match block {
            Block::Paragraph(paragraph) => {
                visit(paragraph);
                for run in &paragraph.runs {
                    for inline in &run.content {
                        if let Inline::Note(note) = inline {
                            visit_blocks(&note.body, visit);
                        }
                    }
                }
            }
            Block::Table(table) => {
                if let Some(caption) = &table.caption {
                    visit_blocks(&caption.blocks, visit);
                }
                for cell in &table.cells {
                    visit_blocks(&cell.blocks, visit);
                }
            }
        }
    }
}

fn validate_single_face(bytes: &[u8]) -> Result<(), String> {
    if bytes.starts_with(b"ttcf") {
        return Err("font collections (TTC/OTC) are unsupported".into());
    }
    if bytes.len() < 12
        || !(bytes.starts_with(&[0, 1, 0, 0])
            || bytes.starts_with(b"OTTO")
            || bytes.starts_with(b"true")
            || bytes.starts_with(b"typ1"))
    {
        return Err("unsupported or malformed single-face TTF/OTF".into());
    }
    ttf_parser::Face::parse(bytes, 0)
        .map_err(|_| "unsupported or malformed single-face TTF/OTF".to_string())?;
    Ok(())
}

fn normalize_family(family: &str) -> String {
    family
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn split_legacy_style(family: &str) -> (String, FontStyle) {
    let mut words: Vec<&str> = family.split_whitespace().collect();
    let mut bold = false;
    let mut italic = false;
    while let Some(word) = words.last() {
        match word.to_ascii_lowercase().as_str() {
            "bold" | "boldface" => bold = true,
            "italic" | "oblique" => italic = true,
            "regular" => {}
            _ => break,
        }
        words.pop();
    }
    (words.join(" "), FontStyle::from_flags(bold, italic))
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex_bytes(&Sha256::digest(bytes))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn category_name(category: FontCategory) -> &'static str {
    match category {
        FontCategory::Serif => "serif",
        FontCategory::Gothic => "gothic",
        FontCategory::Other => "other",
    }
}

fn script_slot(ch: char) -> ScriptClass {
    match ch as u32 {
        0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7A3 | 0xD7B0..=0xD7FF => {
            ScriptClass::Hangul
        }
        0x2E80..=0x2FDF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF => ScriptClass::Hanja,
        0x3040..=0x30FF => ScriptClass::Japanese,
        0x0000..=0x024F => ScriptClass::Latin,
        _ => ScriptClass::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gothic() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Regular.ttf"
        ))
        .unwrap()
    }

    fn face(family: &str, style: FontStyle) -> FontFaceInput {
        FontFaceInput {
            family: family.to_string(),
            style,
            bytes: gothic(),
            face_index: 0,
        }
    }

    #[test]
    fn registry_is_order_independent_and_rejects_duplicate_style() {
        let a = FontRegistry::new(
            vec![
                face("Nanum Gothic", FontStyle::Regular),
                face("Nanum Myeongjo", FontStyle::Bold),
            ],
            FontRegistryLimits::default(),
        )
        .unwrap();
        let b = FontRegistry::new(
            vec![
                face("Nanum Myeongjo", FontStyle::Bold),
                face("Nanum Gothic", FontStyle::Regular),
            ],
            FontRegistryLimits::default(),
        )
        .unwrap();
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert!(FontRegistry::new(
            vec![
                face(" Nanum   Gothic ", FontStyle::Regular),
                face("nanum gothic", FontStyle::Regular),
            ],
            FontRegistryLimits::default(),
        )
        .unwrap_err()
        .contains("duplicate"));
    }

    #[test]
    fn registry_rejects_collections_indices_and_resource_overruns() {
        let mut collection = face("A", FontStyle::Regular);
        collection.bytes = b"ttcf00000000".to_vec();
        assert!(FontRegistry::new(vec![collection], FontRegistryLimits::default()).is_err());
        let mut indexed = face("A", FontStyle::Regular);
        indexed.face_index = 1;
        assert!(FontRegistry::new(vec![indexed], FontRegistryLimits::default()).is_err());
        assert!(FontRegistry::new(
            vec![face("A", FontStyle::Regular)],
            FontRegistryLimits {
                max_faces: 1,
                max_face_bytes: 12,
                max_total_bytes: 12,
            },
        )
        .is_err());
    }

    #[test]
    fn realization_is_exact_only_when_family_and_style_both_match() {
        let registry = FontRegistry::new(
            vec![face("Nanum Gothic", FontStyle::Regular)],
            FontRegistryLimits::default(),
        )
        .unwrap();
        assert!(registry
            .select(
                Some("Nanum Gothic"),
                FontCategory::Gothic,
                FontStyle::Regular,
            )
            .is_some_and(|(_, exact)| exact));
        assert!(registry
            .select(
                Some("Nanum Gothic"),
                FontCategory::Gothic,
                FontStyle::Italic,
            )
            .is_some_and(|(_, exact)| !exact));
    }
}
