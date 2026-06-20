//! The ONE AI-routing op proving content/design separation (§5.2): a CSS-only edit
//! (`CssSetDecl`) changes ONLY the `.css` projection, leaving every `.jsx` byte-identical.
//!
//! `CssSetDecl` lives here (NOT on the op-bus) per the M0 spec — it operates on the
//! `JsxCssProject` projection, not on `SemanticDoc`. It resolves the target node to its
//! style class (`cN`/`pN`), mutates only `styles`, and sets `dirty.document_css`.

use crate::css::{normalize_value, CssRule, Selector};
use crate::jsx::{JsxElement, JsxNode, NodeKey, Tag};
use crate::map;
use crate::project::JsxCssProject;

/// What a `CssSetDecl` op points at.
#[derive(Clone, Debug)]
pub enum CssTarget {
    /// A paragraph/run addressed by its JSX `id` (e.g. `"n3"`) — resolved to its `.cN`/`.pN` class.
    Node(NodeKey),
    /// A class selector directly (e.g. `"c1"`).
    Class(String),
    /// A tag base rule (e.g. `Run`).
    Tag(Tag),
}

/// A CSS-only declaration set op (design §5.2 `CssSetDecl{selector, prop, value}`).
#[derive(Clone, Debug)]
pub struct CssSetDecl {
    pub target: CssTarget,
    pub prop: String,
    pub value: String,
}

#[derive(Debug)]
pub enum OpError {
    TargetNotFound(String),
    NodeHasNoStyleClass(String),
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpError::TargetNotFound(s) => write!(f, "css target not found: {s}"),
            OpError::NodeHasNoStyleClass(s) => write!(f, "node {s} has no style class (default shape)"),
        }
    }
}
impl std::error::Error for OpError {}

/// Apply a `CssSetDecl` to a project: mutate ONLY the stylesheet + set `dirty.document_css`.
/// Returns the selector that was edited. The caller (or a test) can assert the JSX is unchanged.
pub fn css_set_decl(proj: &mut JsxCssProject, op: &CssSetDecl) -> Result<Selector, OpError> {
    let selector = resolve_selector(proj, &op.target)?;
    let value = normalize_value(&op.prop, &op.value);
    if let Some(rule) = proj.styles.rule_mut(&selector) {
        rule.decls.insert(op.prop.clone(), value);
    } else {
        let mut decls = std::collections::BTreeMap::new();
        decls.insert(op.prop.clone(), value);
        proj.styles.upsert(CssRule { selector: selector.clone(), decls });
    }
    proj.dirty.document_css = true;
    // Crucially: document.jsx / sections / manifest are NOT touched (content/design split).
    Ok(selector)
}

fn resolve_selector(proj: &JsxCssProject, target: &CssTarget) -> Result<Selector, OpError> {
    match target {
        CssTarget::Class(c) => Ok(Selector::Class(c.clone())),
        CssTarget::Tag(t) => Ok(Selector::Tag(t.as_str().to_string())),
        CssTarget::Node(key) => {
            let el = find_by_id(&proj.document, key)
                .or_else(|| proj.sections.iter().find_map(|s| find_by_id(s, key)))
                .ok_or_else(|| OpError::TargetNotFound(key.clone()))?;
            // The node's style class is its own `.cN`/`.pN`; if the addressed node is a Para
            // (whose own class is `.pN`) a *character*-level edit lands on its first child Run's
            // `.cN` class — so a "node X font-size 14pt" instruction resolves correctly.
            node_style_class(el)
                .or_else(|| el.children.iter().find_map(|c| match c {
                    JsxNode::Element(child) => node_style_class(child),
                    _ => None,
                }))
                .ok_or_else(|| OpError::NodeHasNoStyleClass(key.clone()))
        }
    }
}

fn node_style_class(el: &JsxElement) -> Option<Selector> {
    el.class_list
        .iter()
        .find(|c| map::char_class_index(c).is_some() || map::para_class_index(c).is_some())
        .map(|c| Selector::Class(c.clone()))
}

fn find_by_id<'a>(node: &'a JsxNode, key: &str) -> Option<&'a JsxElement> {
    match node {
        JsxNode::Text(_) => None,
        JsxNode::Element(e) => {
            if e.id.as_deref() == Some(key) {
                return Some(e);
            }
            e.children.iter().find_map(|c| find_by_id(c, key))
        }
    }
}
