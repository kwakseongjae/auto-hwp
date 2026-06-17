use thiserror::Error;

/// Engine-wide error type.
#[derive(Debug, Error)]
pub enum Error {
    #[error("unrecognized or unsupported document format")]
    UnknownFormat,

    /// A capability (parser/layout/render/serialize) is not wired in this build.
    /// e.g. rhwp bootstrap not vendored, or a feature is off.
    #[error("capability unavailable: {0}")]
    CapabilityUnavailable(&'static str),

    #[error("not implemented yet: {0}")]
    NotImplemented(&'static str),

    #[error("parse error: {0}")]
    Parse(String),

    #[error("serialize error: {0}")]
    Serialize(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = core::result::Result<T, Error>;
