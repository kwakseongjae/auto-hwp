//! The JSX-content half of the projection: a closed, *purely declarative* node model
//! (no JS expressions, no `.map`, no conditionals — §3.3) plus a hand-rolled
//! recursive-descent emitter/parser over the closed [`Tag`] vocabulary (§3.1).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A stable, disk-serializable node identity (§3.2) — generalizes `NodeId`'s
/// `section:S/para:P` stable key. For M0 we carry the raw key string.
pub type NodeKey = String;

/// The closed HWP-semantic element vocabulary (§3.1). NOT arbitrary HTML.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tag {
    Document,
    Section,
    Page,
    Para,
    Run,
    Span,
    Table,
    TableRow,
    TableCell,
    Image,
    Equation,
    Field,
    Note,
    Bookmark,
    Header,
    Footer,
    Raw,
}

impl Tag {
    pub fn as_str(self) -> &'static str {
        match self {
            Tag::Document => "Document",
            Tag::Section => "Section",
            Tag::Page => "Page",
            Tag::Para => "Para",
            Tag::Run => "Run",
            Tag::Span => "Span",
            Tag::Table => "Table",
            Tag::TableRow => "TableRow",
            Tag::TableCell => "TableCell",
            Tag::Image => "Image",
            Tag::Equation => "Equation",
            Tag::Field => "Field",
            Tag::Note => "Note",
            Tag::Bookmark => "Bookmark",
            Tag::Header => "Header",
            Tag::Footer => "Footer",
            Tag::Raw => "Raw",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Tag> {
        Some(match s {
            "Document" => Tag::Document,
            "Section" => Tag::Section,
            "Page" => Tag::Page,
            "Para" => Tag::Para,
            "Run" => Tag::Run,
            "Span" => Tag::Span,
            "Table" => Tag::Table,
            "TableRow" => Tag::TableRow,
            "TableCell" => Tag::TableCell,
            "Image" => Tag::Image,
            "Equation" => Tag::Equation,
            "Field" => Tag::Field,
            "Note" => Tag::Note,
            "Bookmark" => Tag::Bookmark,
            "Header" => Tag::Header,
            "Footer" => Tag::Footer,
            "Raw" => Tag::Raw,
            _ => return None,
        })
    }
}

/// A JSX node — either an element or a text leaf (§3.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum JsxNode {
    Element(JsxElement),
    Text(JsxText),
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct JsxElement {
    pub tag_str: String, // serialized tag name (kept as String so unknown→Raw is lossless)
    pub class_list: Vec<String>,
    pub id: Option<NodeKey>,
    /// `data-*`, `colSpan`, `href`, `src`, … — deterministic (BTreeMap) for byte-stable emit.
    pub attrs: BTreeMap<String, String>,
    pub children: Vec<JsxNode>,
}

impl JsxElement {
    pub fn new(tag: Tag) -> Self {
        JsxElement {
            tag_str: tag.as_str().to_string(),
            ..Default::default()
        }
    }
    pub fn tag(&self) -> Option<Tag> {
        Tag::from_str(&self.tag_str)
    }
    pub fn with_class(mut self, c: impl Into<String>) -> Self {
        self.class_list.push(c.into());
        self
    }
    pub fn with_attr(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.attrs.insert(k.into(), v.into());
        self
    }
    pub fn with_child(mut self, n: JsxNode) -> Self {
        self.children.push(n);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct JsxText {
    pub node_key: Option<NodeKey>,
    pub text: String,
}

// ---------------------------------------------------------------------------
// Deterministic textual emit (the on-disk JSX). The fixed-point invariant
// (§3.0 / equality.rs) relies on this being a pure function of the node tree.
// ---------------------------------------------------------------------------

/// Render a root JSX node to the on-disk `.jsx` text (deterministic).
pub fn emit_jsx(root: &JsxNode) -> String {
    let mut s = String::new();
    emit_node(root, 0, &mut s);
    s
}

fn indent(n: usize, out: &mut String) {
    for _ in 0..n {
        out.push_str("  ");
    }
}

fn emit_node(node: &JsxNode, depth: usize, out: &mut String) {
    match node {
        JsxNode::Text(t) => {
            indent(depth, out);
            // `{"..."}` literal child form (§3.3): a JSON-escaped string literal.
            out.push('{');
            out.push_str(&serde_json::to_string(&t.text).unwrap_or_else(|_| "\"\"".into()));
            if let Some(k) = &t.node_key {
                out.push_str("/*@");
                out.push_str(k);
                out.push_str("*/");
            }
            out.push('}');
            out.push('\n');
        }
        JsxNode::Element(e) => {
            indent(depth, out);
            out.push('<');
            out.push_str(&e.tag_str);
            if let Some(id) = &e.id {
                out.push_str(" id=");
                out.push_str(&serde_json::to_string(id).unwrap_or_default());
            }
            if !e.class_list.is_empty() {
                out.push_str(" className=");
                let joined = e.class_list.join(" ");
                out.push_str(&serde_json::to_string(&joined).unwrap_or_default());
            }
            for (k, v) in &e.attrs {
                out.push(' ');
                out.push_str(k);
                out.push('=');
                out.push_str(&serde_json::to_string(v).unwrap_or_default());
            }
            if e.children.is_empty() {
                out.push_str(" />\n");
            } else {
                out.push_str(">\n");
                for c in &e.children {
                    emit_node(c, depth + 1, out);
                }
                indent(depth, out);
                out.push_str("</");
                out.push_str(&e.tag_str);
                out.push_str(">\n");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Hand-rolled recursive-descent parser (§3.3) — purely declarative data, never
// evaluates JS. Anything outside the grammar is preserved (caller wraps in Raw).
// ---------------------------------------------------------------------------

pub fn parse_jsx(src: &str) -> Result<JsxNode, String> {
    let mut p = P {
        b: src.as_bytes(),
        i: 0,
    };
    p.ws();
    let n = p.node()?;
    p.ws();
    Ok(n)
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && (self.b[self.i] as char).is_whitespace() {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn starts_with(&self, s: &str) -> bool {
        self.b[self.i..].starts_with(s.as_bytes())
    }

    fn node(&mut self) -> Result<JsxNode, String> {
        self.ws();
        match self.peek() {
            Some(b'<') => self.element(),
            Some(b'{') => self.text_literal(),
            other => Err(format!("unexpected byte {other:?} at {}", self.i)),
        }
    }

    fn text_literal(&mut self) -> Result<JsxNode, String> {
        // `{` JSON-string `}` with an optional `/*@key*/` trailer.
        self.i += 1; // {
        self.ws();
        let s = self.json_string()?;
        self.ws();
        let mut node_key = None;
        if self.starts_with("/*@") {
            self.i += 3;
            let start = self.i;
            while self.i < self.b.len() && !self.starts_with("*/") {
                self.i += 1;
            }
            node_key = Some(String::from_utf8_lossy(&self.b[start..self.i]).into_owned());
            self.i += 2; // */
            self.ws();
        }
        if self.peek() != Some(b'}') {
            return Err(format!("expected }} at {}", self.i));
        }
        self.i += 1;
        Ok(JsxNode::Text(JsxText { node_key, text: s }))
    }

    fn json_string(&mut self) -> Result<String, String> {
        if self.peek() != Some(b'"') {
            return Err(format!("expected string at {}", self.i));
        }
        // Find the matching close quote honoring escapes, then let serde_json parse it.
        let start = self.i;
        self.i += 1;
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'\\' => self.i += 2,
                b'"' => {
                    self.i += 1;
                    let raw = &self.b[start..self.i];
                    let txt = std::str::from_utf8(raw).map_err(|e| e.to_string())?;
                    return serde_json::from_str::<String>(txt).map_err(|e| e.to_string());
                }
                _ => self.i += 1,
            }
        }
        Err("unterminated string".into())
    }

    fn ident(&mut self) -> String {
        let start = self.i;
        while self.i < self.b.len() {
            let c = self.b[self.i] as char;
            if c.is_alphanumeric() || c == '-' || c == '_' {
                self.i += 1;
            } else {
                break;
            }
        }
        String::from_utf8_lossy(&self.b[start..self.i]).into_owned()
    }

    fn element(&mut self) -> Result<JsxNode, String> {
        self.i += 1; // <
        self.ws();
        let tag_str = self.ident();
        if tag_str.is_empty() {
            return Err(format!("expected tag name at {}", self.i));
        }
        let mut el = JsxElement {
            tag_str,
            ..Default::default()
        };
        // attributes
        loop {
            self.ws();
            match self.peek() {
                Some(b'/') | Some(b'>') | None => break,
                _ => {}
            }
            let name = self.ident();
            if name.is_empty() {
                return Err(format!("bad attribute at {}", self.i));
            }
            self.ws();
            if self.peek() != Some(b'=') {
                return Err(format!("expected = after attr {name} at {}", self.i));
            }
            self.i += 1;
            self.ws();
            let val = self.json_string()?;
            match name.as_str() {
                "id" => el.id = Some(val),
                "className" => {
                    el.class_list = val.split_whitespace().map(|s| s.to_string()).collect();
                }
                _ => {
                    el.attrs.insert(name, val);
                }
            }
        }
        self.ws();
        if self.starts_with("/>") {
            self.i += 2;
            return Ok(JsxNode::Element(el));
        }
        if self.peek() != Some(b'>') {
            return Err(format!("expected > at {}", self.i));
        }
        self.i += 1; // >
                     // children until </tag>
        loop {
            self.ws();
            if self.starts_with("</") {
                self.i += 2;
                self.ws();
                let close = self.ident();
                if close != el.tag_str {
                    return Err(format!("mismatched close </{close}> for <{}>", el.tag_str));
                }
                self.ws();
                if self.peek() != Some(b'>') {
                    return Err(format!("expected > closing {} at {}", el.tag_str, self.i));
                }
                self.i += 1;
                break;
            }
            if self.peek().is_none() {
                return Err(format!("unclosed <{}>", el.tag_str));
            }
            let child = self.node()?;
            el.children.push(child);
        }
        Ok(JsxNode::Element(el))
    }
}
