//! Local model provider via **Ollama** (out-of-process HTTP) — our-controlled generation with no
//! cloud key. Default model `qwen3` (override `TF_HWP_LOCAL_MODEL`); host from `OLLAMA_HOST` or
//! `http://localhost:11434`. License-clean: Ollama runs as a separate process; we only speak HTTP.

use super::{content, LlmProvider};
use hwp_model::error::{Error, Result};

const DEFAULT_HOST: &str = "http://localhost:11434";
/// Default local model — override via `TF_HWP_LOCAL_MODEL`.
pub const DEFAULT_MODEL: &str = "qwen3";

fn host_from_env() -> String {
    std::env::var("OLLAMA_HOST")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_HOST.to_string())
}

pub struct OllamaProvider {
    host: String,
    model: String,
}

impl OllamaProvider {
    /// Host from `OLLAMA_HOST`, model from `TF_HWP_LOCAL_MODEL` (else the defaults).
    pub fn from_env() -> Self {
        let model = std::env::var("TF_HWP_LOCAL_MODEL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string());
        Self {
            host: host_from_env(),
            model,
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Is a local Ollama server reachable? (used for `auto` provider selection — fast, fail-soft).
    pub fn available() -> bool {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(400))
            .build()
            .and_then(|c| c.get(format!("{}/api/tags", host_from_env())).send())
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// One non-streaming chat completion; returns the assistant message text.
    fn chat(&self, system: &str, user: &str) -> Result<String> {
        let body = serde_json::json!({
            "model": self.model,
            "stream": false,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        let resp = reqwest::blocking::Client::new()
            .post(format!("{}/api/chat", self.host))
            .json(&body)
            .send()
            .map_err(|e| {
                Error::Other(format!(
                    "ollama request failed (is `ollama serve` running?): {e}"
                ))
            })?;
        let status = resp.status();
        let val: serde_json::Value = resp
            .json()
            .map_err(|e| Error::Other(format!("ollama response decode failed: {e}")))?;
        if !status.is_success() {
            let msg = val
                .pointer("/error")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(Error::Other(format!("ollama API {status}: {msg}")));
        }
        Ok(val
            .pointer("/message/content")
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_string())
    }
}

impl LlmProvider for OllamaProvider {
    fn name(&self) -> &str {
        "local(ollama)"
    }

    fn propose_paragraphs(&self, context: &str, instruction: &str) -> Result<Vec<String>> {
        let system = "당신은 한국 공문서 작성 보조자입니다. 추가할 본문 문단만 한 줄에 하나씩, \
                      설명·머리말·번호 없이 출력하세요.";
        let user = format!("[문서 맥락]\n{context}\n\n[지시]\n{instruction}");
        let text = self.chat(system, &user)?;
        Ok(text
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    /// Drive the RICH pipeline: prompt with the content template so the local model emits one
    /// `AiContent` JSON object, then validate/parse it (no raw XML).
    fn propose_content(&self, context: &str, instruction: &str) -> Result<content::AiContent> {
        let user = format!(
            "[문서 맥락]\n{context}\n\n[지시]\n{instruction}\n\n위 지시에 따라 추가할 콘텐츠를 \
             템플릿 JSON으로 출력하세요."
        );
        let raw = self.chat(content::template_brief(), &user)?;
        content::parse_content(content::strip_code_fence(&raw))
    }

    /// Anchored chat-editing: prompt with the edit brief + the document's `[s/b]` outline so the
    /// local model emits one `EditScript` JSON, then parse it (no raw XML).
    fn propose_edit_script(
        &self,
        outline: &str,
        instruction: &str,
    ) -> Result<super::edit::EditScript> {
        let user = format!(
            "[문서 개요]\n{outline}\n\n[편집 지시]\n{instruction}\n\n위 지시를 편집 명령 JSON으로 출력하세요."
        );
        let raw = self.chat(super::edit::edit_brief(), &user)?;
        super::edit::parse_script(content::strip_code_fence(&raw))
    }
}
