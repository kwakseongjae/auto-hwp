//! Anthropic Claude provider (cloud BYOK) via the Messages API over raw HTTP.
//!
//! No official Anthropic Rust SDK exists, so we call the REST API directly (reqwest blocking,
//! non-streaming). BYOK: the key is read from `ANTHROPIC_API_KEY` (env). Default model is
//! `claude-opus-4-8` (best quality for formal Korean government-document drafting); override
//! with `TF_HWP_MODEL`. Sampling params (temperature/top_p/top_k) are intentionally omitted —
//! they are removed on Opus 4.8 and would 400.

use super::LlmProvider;
use hwp_model::error::{Error, Result};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Default model — quality-first for Korean 공문서 drafting (override via TF_HWP_MODEL).
pub const DEFAULT_MODEL: &str = "claude-opus-4-8";

const SYSTEM_PROMPT: &str = "당신은 한국 공문서 작성 보조자입니다. 주어진 문서 맥락과 지시에 따라, \
추가할 새 문단만 한국어 공문서체로 작성하세요. 머리말·설명·마크다운·번호 없이 본문 문단만, \
한 줄에 한 문단씩 출력하세요.";

pub struct AnthropicProvider {
    api_key: String,
    model: String,
}

impl AnthropicProvider {
    /// BYOK: read the key from `ANTHROPIC_API_KEY`; model from `TF_HWP_MODEL` or the default.
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
            Error::CapabilityUnavailable("set ANTHROPIC_API_KEY (BYOK) to use the Anthropic provider")
        })?;
        if api_key.trim().is_empty() {
            return Err(Error::CapabilityUnavailable("ANTHROPIC_API_KEY is empty"));
        }
        let model = std::env::var("TF_HWP_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        Ok(Self { api_key, model })
    }

    pub fn model(&self) -> &str {
        &self.model
    }
}

impl LlmProvider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn propose_paragraphs(&self, context: &str, instruction: &str) -> Result<Vec<String>> {
        let user = format!(
            "[문서 맥락]\n{context}\n\n[지시]\n{instruction}\n\n위 지시에 따라 추가할 문단을 작성하세요."
        );
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT,
            "messages": [{ "role": "user", "content": user }],
        });

        let resp = reqwest::blocking::Client::new()
            .post(API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .map_err(|e| Error::Other(format!("anthropic request failed: {e}")))?;

        let status = resp.status();
        let val: serde_json::Value = resp
            .json()
            .map_err(|e| Error::Other(format!("anthropic response decode failed: {e}")))?;

        if !status.is_success() {
            let msg = val
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(Error::Other(format!("anthropic API {status}: {msg}")));
        }

        // content: [{type, text}, ...] → concatenate text blocks.
        let text = val
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        Ok(text
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }
}
