import type { Anchor, DocMeta, EditRequest } from "./types";

/// Doc-context assembly (SDK-LAYERS: "buildDocContext(session, anchors) — R5 펜스 포함"). PROMOTED from
/// apps/hwp-lab's LabWorkspace.buildDocContextString + the route handler's user-message assembly so the
/// CLIENT (which sends the doc-context string) and the SERVER (which R5-fences it into the LLM turn)
/// share one implementation. Pure string building — no fetch, no key.

/** Build the doc-context STRING the client sends to its proxy: a compact header (format/pages/…) plus one
 *  line per marked anchor (structure indices + the anchor's current text). The anchor `text` is
 *  document-derived, hence UNTRUSTED — it is fenced as DATA on the server (see `buildUserMessage`). Elided
 *  to `maxLen` (default 8000) chars. Verbatim behavior of the reference LabWorkspace builder. */
export function buildDocContext(meta: DocMeta, anchors: Anchor[], opts?: { maxLen?: number }): string {
  const maxLen = opts?.maxLen ?? 8000;
  const head = `format=${meta.format} pages=${meta.pages} editable=${meta.editable} sections=${meta.sections}`;
  const lines = anchors.map((a, i) => {
    const rows = a.rows ? ` rows=[${a.rows[0]},${a.rows[1]}]` : "";
    const cols = a.cols ? ` cols=[${a.cols[0]},${a.cols[1]}]` : "";
    return `#${i} ${a.kind} section=${a.section} block=${a.block}${rows}${cols} text=${JSON.stringify(a.text ?? "")}`;
  });
  return [head, ...lines].join("\n").slice(0, maxLen);
}

/** Assemble the LLM USER turn from an EditRequest, wrapping the doc-context in the R5 `<document-content>`
 *  fence (the fence marks it as untrusted DATA — never instructions). PROMOTED verbatim from the reference
 *  proxy's user-message assembly; the host pairs it with `buildSystemPrompt()` for the system turn. */
export function buildUserMessage(req: EditRequest): string {
  return [
    `사용자 지시: ${req.instruction}`,
    "",
    "마킹된 앵커(편집 대상, 구조 인덱스 — 이 위치만 편집):",
    JSON.stringify(req.anchors),
    "",
    "<document-content>",
    req.docContext,
    "</document-content>",
  ].join("\n");
}
