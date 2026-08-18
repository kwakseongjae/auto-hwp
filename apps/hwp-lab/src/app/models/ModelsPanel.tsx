"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./models.module.css";

type KeySource = "session" | "env" | null;

type Status = {
  connected: boolean;
  keySource: KeySource;
  selectedModel: string | null;
  defaultModel: string;
};

type CatalogEntry = { id: string; name: string };

const ERRORS: Record<string, string> = {
  missing_code: "인가 코드가 없습니다. 다시 연결해 주세요.",
  missing_verifier: "인가 세션이 만료됐습니다. 다시 연결해 주세요.",
  exchange_failed: "인가 코드를 키로 바꾸지 못했습니다. 다시 연결해 주세요.",
};

export function ModelsPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<CatalogEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queryError = useMemo(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("error");
    return code ? (ERRORS[code] ?? "연결에 실패했습니다. 다시 시도해 주세요.") : null;
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/auth/openrouter/status", { method: "GET" });
    if (res.status === 404) {
      setError("로컬 Models 진입점은 이 서버에서 꺼져 있습니다.");
      return;
    }
    if (!res.ok) throw new Error("상태를 읽지 못했습니다.");
    const data = (await res.json()) as Status;
    setStatus(data);
  }, []);

  const loadCatalog = useCallback(async () => {
    const res = await fetch("/api/auth/openrouter/models", { method: "GET" });
    if (!res.ok) {
      setModels([]);
      return;
    }
    const data = (await res.json()) as { models?: CatalogEntry[] };
    setModels(Array.isArray(data.models) ? data.models : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(queryError);
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("connected") === "1") {
      setNotice("OpenRouter에 연결했습니다. 아래에서 모델을 고르면 채팅·인라인 편집에 바로 쓰입니다.");
    }
    void (async () => {
      try {
        await loadStatus();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStatus, queryError]);

  useEffect(() => {
    if (!status?.keySource) return;
    void loadCatalog();
  }, [status?.keySource, loadCatalog]);

  const onSelect = async (model: string) => {
    setBusy("모델 저장 중…");
    setError(null);
    try {
      const res = await fetch("/api/auth/openrouter/model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) throw new Error("모델 선택을 저장하지 못했습니다.");
      const data = (await res.json()) as { selectedModel?: string };
      setStatus((prev) => (prev ? { ...prev, selectedModel: data.selectedModel ?? model } : prev));
      setNotice(`선택한 모델: ${model}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDisconnect = async () => {
    setBusy("연결 해제 중…");
    setError(null);
    try {
      const res = await fetch("/api/auth/openrouter/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("연결을 끊지 못했습니다.");
      const data = (await res.json()) as Status;
      setStatus({
        connected: false,
        keySource: data.keySource ?? null,
        selectedModel: data.selectedModel ?? null,
        defaultModel: data.defaultModel || status?.defaultModel || "x-ai/grok-4.5",
      });
      if (data.keySource) await loadCatalog();
      else setModels(null);
      setNotice("이 서버 메모리의 키를 지웠습니다. OpenRouter 대시보드의 키는 직접 폐기하세요.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const currentModel = status?.selectedModel || status?.defaultModel || "";
  const canSelect = Boolean(status?.keySource);

  return (
    <section className={styles.card} data-testid="openrouter-card">
      <header className={styles.cardHead}>
        <h2>Connect OpenRouter</h2>
        <p>
          OAuth PKCE(S256)로 연결합니다. 교환된 키는 이 개발 서버 메모리에만 있고, 브라우저는 연결
          여부와 키 출처만 봅니다.
        </p>
      </header>

      <dl className={styles.meta}>
        <div>
          <dt>연결</dt>
          <dd data-testid="openrouter-connected">{status?.connected ? "연결됨" : "안 됨"}</dd>
        </div>
        <div>
          <dt>키 출처</dt>
          <dd data-testid="openrouter-key-source">{status?.keySource ?? "없음"}</dd>
        </div>
      </dl>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      <div className={styles.actions}>
        <a className={styles.primary} href="/api/auth/openrouter/connect" data-testid="openrouter-connect">
          {status?.connected ? "다시 연결" : "Connect OpenRouter"}
        </a>
        {status?.connected && (
          <button type="button" className={styles.secondary} onClick={() => void onDisconnect()} disabled={Boolean(busy)}>
            연결 끊기
          </button>
        )}
      </div>

      {canSelect && (
        <label className={styles.selectLabel}>
          모델
          <select
            data-testid="openrouter-model"
            value={currentModel}
            disabled={Boolean(busy) || !models}
            onChange={(e) => void onSelect(e.target.value)}
          >
            {!models && <option value={currentModel}>{currentModel || "카탈로그 불러오는 중…"}</option>}
            {models && !models.some((m) => m.id === currentModel) && currentModel && (
              <option value={currentModel}>{currentModel}</option>
            )}
            {models?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === m.name ? m.id : `${m.name} (${m.id})`}
              </option>
            ))}
          </select>
        </label>
      )}

      {busy && (
        <p className={styles.busy} role="status">
          {busy}
        </p>
      )}

      <p className={styles.footnote}>
        연결 끊기는 이 서버 메모리만 지웁니다. OpenRouter에 남은 키는{" "}
        <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">
          OpenRouter 키 설정
        </a>
        에서 직접 폐기하세요.
      </p>
    </section>
  );
}
