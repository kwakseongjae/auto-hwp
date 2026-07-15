//! The CSS-design half of the projection (§3.4): a closed `CssProp` subset and a
//! flat `Stylesheet` (`.class | #id | Tag` selectors, no specificity engine).
//! Deterministic emit via BTreeMap-ordered decls + sorted rules (§5.3 risk).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Closed CSS property subset (§3.4). String-backed so unknown props are still
/// preserved losslessly, but the known set is what the AI router / layout consume.
pub type CssProp = String;
pub type CssValue = String;

/// A flat selector. Ordering is deterministic: Tag < Class < Id, then name.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Selector {
    Tag(String),
    Class(String),
    Id(String),
}

impl Default for Selector {
    fn default() -> Self {
        Selector::Tag(String::new())
    }
}

impl Selector {
    pub fn render(&self) -> String {
        match self {
            Selector::Tag(t) => t.clone(),
            Selector::Class(c) => format!(".{c}"),
            Selector::Id(i) => format!("#{i}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct CssRule {
    pub selector: Selector,
    pub decls: BTreeMap<CssProp, CssValue>,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct Stylesheet {
    pub rules: Vec<CssRule>,
}

impl Stylesheet {
    /// Find the rule for a selector (mutable), if present.
    pub fn rule_mut(&mut self, sel: &Selector) -> Option<&mut CssRule> {
        self.rules.iter_mut().find(|r| &r.selector == sel)
    }
    pub fn rule(&self, sel: &Selector) -> Option<&CssRule> {
        self.rules.iter().find(|r| &r.selector == sel)
    }
    /// Insert/replace a rule, keeping the rule list sorted by selector for determinism.
    pub fn upsert(&mut self, rule: CssRule) {
        if let Some(existing) = self.rule_mut(&rule.selector) {
            *existing = rule;
        } else {
            self.rules.push(rule);
        }
        self.rules.sort_by(|a, b| a.selector.cmp(&b.selector));
    }
}

/// Normalize a CSS value for *exact-match* dedup (§5.3): lowercase hex colors,
/// collapse `14.0pt`→`14pt`. Conservative — only the cases the design names.
pub fn normalize_value(prop: &str, value: &str) -> String {
    let v = value.trim();
    // color normalization: #FF0000 / #f00 → #ff0000
    if prop.contains("color") || prop == "background-color" {
        if let Some(c) = parse_hex_color(v) {
            return c;
        }
    }
    // numeric unit normalization: strip a trailing `.0` mantissa before the unit.
    if let Some((num, unit)) = split_num_unit(v) {
        if let Ok(f) = num.parse::<f64>() {
            // canonical: integer if whole, else trimmed
            let canon = if f.fract() == 0.0 {
                format!("{}", f as i64)
            } else {
                let mut s = format!("{f}");
                while s.ends_with('0') {
                    s.pop();
                }
                s
            };
            return format!("{canon}{unit}");
        }
    }
    v.to_string()
}

fn split_num_unit(v: &str) -> Option<(&str, &str)> {
    let idx = v.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))?;
    if idx == 0 {
        return None;
    }
    let (num, unit) = v.split_at(idx);
    let unit = unit.trim();
    if matches!(unit, "px" | "pt" | "%" | "em") {
        Some((num, unit))
    } else {
        None
    }
}

fn parse_hex_color(v: &str) -> Option<String> {
    let h = v.strip_prefix('#')?;
    let full = match h.len() {
        3 => {
            let mut s = String::with_capacity(6);
            for c in h.chars() {
                s.push(c);
                s.push(c);
            }
            s
        }
        6 => h.to_string(),
        _ => return None,
    };
    if full.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(format!("#{}", full.to_ascii_lowercase()))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Deterministic CSS text emit / parse (the on-disk `.css`).
// ---------------------------------------------------------------------------

pub fn emit_css(sheet: &Stylesheet) -> String {
    let mut out = String::new();
    for rule in &sheet.rules {
        out.push_str(&rule.selector.render());
        out.push_str(" {\n");
        for (k, v) in &rule.decls {
            out.push_str("  ");
            out.push_str(k);
            out.push_str(": ");
            out.push_str(v);
            out.push_str(";\n");
        }
        out.push_str("}\n");
    }
    out
}

pub fn parse_css(src: &str) -> Result<Stylesheet, String> {
    let mut rules = Vec::new();
    let bytes = src.as_bytes();
    let mut i = 0;
    let skip_ws = |i: &mut usize| {
        while *i < bytes.len() && (bytes[*i] as char).is_whitespace() {
            *i += 1;
        }
    };
    loop {
        skip_ws(&mut i);
        if i >= bytes.len() {
            break;
        }
        // selector up to '{'
        let sel_start = i;
        while i < bytes.len() && bytes[i] != b'{' {
            i += 1;
        }
        if i >= bytes.len() {
            return Err("rule missing '{'".into());
        }
        let sel_txt = src[sel_start..i].trim().to_string();
        i += 1; // {
        let body_start = i;
        // Scan to the MATCHING '}' at brace depth 0 — a declaration VALUE may itself contain a
        // balanced `{...}` (the lossless `--shape: {json}` custom property), so a naive "first '}'"
        // truncates the rule and derails the whole parse.
        let mut depth = 0usize;
        while i < bytes.len() {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' if depth == 0 => break,
                b'}' => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        if i >= bytes.len() {
            return Err("rule missing '}'".into());
        }
        let body = &src[body_start..i];
        i += 1; // }
        let selector = parse_selector(&sel_txt)?;
        let mut decls = BTreeMap::new();
        for decl in body.split(';') {
            let decl = decl.trim();
            if decl.is_empty() {
                continue;
            }
            let (k, v) = decl
                .split_once(':')
                .ok_or_else(|| format!("bad decl '{decl}'"))?;
            decls.insert(k.trim().to_string(), v.trim().to_string());
        }
        rules.push(CssRule { selector, decls });
    }
    Ok(Stylesheet { rules })
}

fn parse_selector(s: &str) -> Result<Selector, String> {
    if let Some(c) = s.strip_prefix('.') {
        Ok(Selector::Class(c.to_string()))
    } else if let Some(i) = s.strip_prefix('#') {
        Ok(Selector::Id(i.to_string()))
    } else if !s.is_empty() {
        Ok(Selector::Tag(s.to_string()))
    } else {
        Err("empty selector".into())
    }
}
