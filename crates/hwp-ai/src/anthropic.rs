//! Anthropic Claude provider (cloud BYOK) via the Messages API over raw HTTP.
//!
//! No official Anthropic Rust SDK exists, so we call the REST API directly (reqwest blocking,
//! non-streaming). BYOK: the key is read from `ANTHROPIC_API_KEY` (env). Default model is
//! `claude-opus-4-8` (best quality for formal Korean government-document drafting); override
//! with `TF_HWP_MODEL`. Sampling params (temperature/top_p/top_k) are intentionally omitted —
//! they are removed on Opus 4.8 and would 400.

use super::{content, LlmProvider};
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
    /// BYOK: resolve the key from `ANTHROPIC_API_KEY` (env) or the OS keychain (feature `keyring`);
    /// model from `TF_HWP_MODEL` or the default.
    pub fn from_env() -> Result<Self> {
        let api_key = super::secret::resolve_anthropic_key().ok_or(Error::CapabilityUnavailable(
            "no Anthropic key — set ANTHROPIC_API_KEY or store one (tf-hwp ai-key set)",
        ))?;
        let model = std::env::var("TF_HWP_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        Ok(Self { api_key, model })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// One non-streaming Messages API call; returns the concatenated text blocks.
    fn complete(&self, system: &str, user: &str) -> Result<String> {
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "system": system,
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
        Ok(val
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default())
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
        let text = self.complete(SYSTEM_PROMPT, &user)?;
        Ok(text
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    /// Drive the RICH pipeline: prompt with the content template so the model emits a single
    /// `AiContent` JSON object, then validate/parse it into typed content (no raw XML ever).
    fn propose_content(&self, context: &str, instruction: &str) -> Result<content::AiContent> {
        let user = format!(
            "[문서 맥락]\n{context}\n\n[지시]\n{instruction}\n\n위 지시에 따라 추가할 콘텐츠를 \
             템플릿 JSON으로 출력하세요."
        );
        let raw = self.complete(content::template_brief(), &user)?;
        content::parse_content(content::strip_code_fence(&raw))
    }

    /// Anchored chat-editing: prompt with the edit brief + the document's `[s/b]` outline so the
    /// model emits a single `EditScript` JSON, then parse it (no raw XML ever).
    fn propose_edit_script(&self, outline: &str, instruction: &str) -> Result<super::edit::EditScript> {
        let user = format!(
            "[문서 개요]\n{outline}\n\n[편집 지시]\n{instruction}\n\n위 지시를 편집 명령 JSON으로 출력하세요."
        );
        let raw = self.complete(super::edit::edit_brief(), &user)?;
        super::edit::parse_script(content::strip_code_fence(&raw))
    }
}
