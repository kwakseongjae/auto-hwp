//! `hwp-model` — the format-neutral core.
//!
//! Defines the [`SemanticDoc`] AST (the source of truth), the round-trip-safety
//! primitives ([`Provenance`], [`Passthrough`], [`Dirty`]), the Korean-typography
//! style model ([`style`]), and the **capability traits** that every engine
//! component plugs into. rhwp and our own implementations are interchangeable
//! behind these traits — see `docs/DEPENDENCY-STRATEGY.md`.
//!
//! This crate is pure and `wasm32`-clean (only `thiserror`).

pub mod capability;
pub mod document;
pub mod error;
pub mod font_class;
pub mod layout;
pub mod normalize;
pub mod style;
pub mod types;

pub mod prelude {
    pub use crate::capability::*;
    pub use crate::document::*;
    pub use crate::error::{Error, Result};
    pub use crate::font_class::*;
    pub use crate::layout::*;
    pub use crate::normalize::{normalize_line_spacing, NormalizeReport};
    pub use crate::style::*;
    pub use crate::types::*;
}
