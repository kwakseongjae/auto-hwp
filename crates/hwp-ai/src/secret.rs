//! BYOK key storage. The Anthropic key is resolved from the `ANTHROPIC_API_KEY` env var first
//! (CI / headless / explicit override), then — with the `keyring` feature — the OS keychain. This
//! keeps automated tests and CI keyless (they never touch the keychain) while letting a real user
//! persist the key securely instead of exporting it every session.

#[cfg(feature = "keyring")]
use hwp_model::error::{Error, Result};

/// Keychain service/account identifying the stored Anthropic key.
#[cfg(feature = "keyring")]
const SERVICE: &str = "tf-hwp";
#[cfg(feature = "keyring")]
const ACCOUNT: &str = "anthropic-api-key";

/// The Anthropic API key, if available: `ANTHROPIC_API_KEY` env first, then the OS keychain
/// (only when built with `--features keyring`). `None` if neither is set.
pub fn resolve_anthropic_key() -> Option<String> {
    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
        if !k.trim().is_empty() {
            return Some(k);
        }
    }
    keychain_key()
}

/// True if a key is resolvable from either source (used for `auto` provider selection).
pub fn has_anthropic_key() -> bool {
    resolve_anthropic_key().is_some()
}

#[cfg(feature = "keyring")]
fn keychain_key() -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(k) if !k.trim().is_empty() => Some(k),
        _ => None,
    }
}

#[cfg(not(feature = "keyring"))]
fn keychain_key() -> Option<String> {
    None
}

/// Persist the Anthropic key in the OS keychain (overwrites any existing entry).
#[cfg(feature = "keyring")]
pub fn store_anthropic_key(key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(Error::Other("refusing to store an empty API key".into()));
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| Error::Other(format!("keychain open: {e}")))?;
    entry.set_password(key).map_err(|e| Error::Other(format!("keychain store: {e}")))
}

/// Remove the stored Anthropic key from the OS keychain (Ok even if none was stored).
#[cfg(feature = "keyring")]
pub fn clear_anthropic_key() -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| Error::Other(format!("keychain open: {e}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::Other(format!("keychain clear: {e}"))),
    }
}

/// Where the key is currently coming from — for a `status` readout.
pub fn key_source() -> KeySource {
    if std::env::var("ANTHROPIC_API_KEY").map(|k| !k.trim().is_empty()).unwrap_or(false) {
        KeySource::Env
    } else if keychain_key().is_some() {
        KeySource::Keychain
    } else {
        KeySource::None
    }
}

/// Resolved source of the BYOK key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySource {
    Env,
    Keychain,
    None,
}

impl KeySource {
    pub fn label(self) -> &'static str {
        match self {
            KeySource::Env => "ANTHROPIC_API_KEY (env)",
            KeySource::Keychain => "OS keychain",
            KeySource::None => "not set",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ENV resolution works with NO keychain and NO network — the keyless test path.
    #[test]
    fn env_key_is_resolved_without_keychain() {
        // SAFETY: single-threaded test; restore afterward.
        let prev = std::env::var("ANTHROPIC_API_KEY").ok();
        std::env::set_var("ANTHROPIC_API_KEY", "sk-test-controlled");
        assert_eq!(resolve_anthropic_key().as_deref(), Some("sk-test-controlled"));
        assert!(has_anthropic_key());
        assert_eq!(key_source(), KeySource::Env);

        std::env::set_var("ANTHROPIC_API_KEY", "   ");
        assert_eq!(key_source(), KeySource::None, "blank env is treated as unset");

        match prev {
            Some(v) => std::env::set_var("ANTHROPIC_API_KEY", v),
            None => std::env::remove_var("ANTHROPIC_API_KEY"),
        }
    }
}
