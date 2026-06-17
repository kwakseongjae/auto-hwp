//! OpenRouter provider (BYOK, OpenAI-compatible Chat Completions). Key from `OPENROUTER_API_KEY`
//! (env or keychain); model from `TF_HWP_OPENROUTER_MODEL` (any OpenRouter slug). Out-of-process
//! HTTP only — license-clean. Drives the SAME rich `propose_content` pipeline as the other providers.

use super::{content, secret, LlmProvider};
use hwp_model::error::{Error, Result};

const API_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
/// Default model — a Gemini Flash. Override with `TF_HWP_OPENROUTER_MODEL` (exact OpenRouter slug).
pub const DEFAULT_MODEL: &str = "google/gemini-2.5-flash";

pub struct OpenRouterProvider {
    api_key: String,
    model: String,
}

impl OpenRouterProvider {
    /// Key from `OPENROUTER_API_KEY` (env/keychain); model from `TF_HWP_OPENROUTER_MODEL` or default.
    pub fn from_env() -> Result<Self> {
        let api_key = secret::resolve_openrouter_key().ok_or(Error::CapabilityUnavailable(
            "set OPENROUTER_API_KEY to use the OpenRouter provider",
        ))?;
        let model = std::env::var("TF_HWP_OPENROUTER_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        Ok(Self { api_key, model })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// One non-streaming chat completion; returns the assistant message text.
    fn complete(&self, system: &str, user: &str) -> Result<String> {
        let body = serde_json::json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        let resp = reqwest::blocking::Client::new()
            .post(API_URL)
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("content-type", "application/json")
            // OpenRouter optional attribution headers (rankings / dashboard).
            .header("http-referer", "https://github.com/kwakseongjae/tf-hwp")
            .header("x-title", "tf-hwp")
            .json(&body)
            .send()
            .map_err(|e| Error::Other(format!("openrouter request failed: {e}")))?;
        let status = resp.status();
        let val: serde_json::Value =
            resp.json().map_err(|e| Error::Other(format!("openrouter response decode failed: {e}")))?;
        if !status.is_success() {
            let msg = val.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("unknown error");
            return Err(Error::Other(format!("openrouter API {status}: {msg}")));
        }
        Ok(val
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_string())
    }
}

impl LlmProvider for OpenRouterProvider {
    fn name(&self) -> &str {
        "openrouter"
    }

    fn propose_paragraphs(&self, context: &str, instruction: &str) -> Result<Vec<String>> {
        let system = "당신은 한국 공문서 작성 보조자입니다. 추가할 본문 문단만 한 줄에 하나씩, \
                      설명·머리말·번호 없이 출력하세요.";
        let user = format!("[문서 맥락]\n{context}\n\n[지시]\n{instruction}");
        let text = self.complete(system, &user)?;
        Ok(text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
    }

    /// Drive the RICH pipeline: prompt with the content template so the model emits one `AiContent`
    /// JSON object, then validate/parse it (no raw XML). Tolerates a Markdown code fence.
    fn propose_content(&self, context: &str, instruction: &str) -> Result<content::AiContent> {
        let user = format!(
            "[문서 맥락]\n{context}\n\n[지시]\n{instruction}\n\n위 지시에 따라 추가할 콘텐츠를 \
             템플릿 JSON으로 출력하세요."
        );
        let raw = self.complete(content::template_brief(), &user)?;
        content::parse_content(content::strip_code_fence(&raw))
    }
}
