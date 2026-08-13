"use client";

import { useState } from "react";
import { trackAgentPromptCopy } from "@/lib/workspace/analytics";
import styles from "./docs.module.css";

type Props = {
  title: string;
  prompt: string;
};

function copyWithTextarea(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

export function AgentPromptCard({ title, prompt }: Props) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt);
      else if (!copyWithTextarea(prompt)) throw new Error("clipboard unavailable");
      setResult("copied");
      trackAgentPromptCopy({ result: "success" });
    } catch {
      const copied = copyWithTextarea(prompt);
      setResult(copied ? "copied" : "failed");
      trackAgentPromptCopy({ result: copied ? "success" : "failed" });
    }
  };

  return (
    <section className={styles.agentPromptCard} aria-labelledby="agent-prompt-title">
      <div className={styles.agentPromptHead}>
        <div>
          <p className={styles.agentPromptKicker}>AGENT FIRST</p>
          <h2 id="agent-prompt-title">{title}</h2>
        </div>
        <button type="button" onClick={copy} data-testid="agent-prompt-copy">
          {result === "copied" ? "복사됨" : result === "failed" ? "복사 실패" : "프롬프트 복사"}
        </button>
      </div>
      <p className={styles.agentPromptIntro}>
        에이전트가 문서에 없는 API를 추측하지 않고 stable 버전과 로컬 데이터 경계를 지킨 채 실제 파일
        검증까지 마치도록 만든 시작 요청입니다.
      </p>
      <pre className={styles.agentPromptBody} data-testid="agent-prompt">
        <code>{prompt}</code>
      </pre>
    </section>
  );
}
