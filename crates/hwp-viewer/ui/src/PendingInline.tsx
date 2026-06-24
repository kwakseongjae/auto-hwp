import type { ProposalOp } from "./api";

/// The INLINE review surface for an AI-proposed edit (the chat card's primary twin). When the chat
/// proposer returns a pending proposal, App marks the target page with a distinct "제안됨" band and
/// floats this toolbar over it — so the user CONFIRMS (✓ → it settles into the doc), REJECTS (✕ →
/// removed), or REFINES (✎ → re-opens the chat scoped to that block to give more feedback) right ON
/// the document, instead of only in the chat panel. Purely presentational: every action just calls
/// the handler App passes (which routes through the same commit_proposal / discard_proposal op-bus).

/** Per-op-kind glyph for the compact summary chips (mirrors Chat's OP_META, kept tiny here). */
const OP_ICON: Record<string, string> = {
  append_paragraph: "¶",
  insert_paragraph: "¶",
  append_table: "▦",
  insert_table: "▦",
  insert_image: "🖼",
  insert_rows: "▤",
  set_cell: "▣",
  shade_cells: "◧",
  delete_block: "－",
  page_layout: "▭",
  resize_image: "⤢",
  edit: "✎",
};

/** A short one-line summary of the proposal's ops for the band header (first op + a "+N" count). */
function summarize(ops: ProposalOp[]): string {
  if (ops.length === 0) return "제안된 편집";
  const first = ops[0].summary || "편집";
  return ops.length > 1 ? `${first} 외 ${ops.length - 1}건` : first;
}

/** The pending band + floating ✓확정 / ✕취소 / ✎다시 toolbar, anchored over the target page wrapper.
 *  `busy` disables the buttons while a commit is in flight; `mock` softens the copy to "예시 제안". */
export function PendingInline(props: {
  ops: ProposalOp[];
  provider: string;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onRefine: () => void;
}) {
  const { ops, provider, busy } = props;
  const isMock = provider === "mock" || provider === "none";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-3">
      {/* The distinct "제안됨" band — a dashed AI-lane outline + a soft generative tint, so the
          pending content reads as NOT-yet-settled, clearly different from committed document ink. */}
      <div className="pending-band pointer-events-auto relative overflow-hidden rounded-lg px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ai/15 px-2 py-0.5 text-[11px] font-medium text-ai">
            ✦ {isMock ? "예시 제안" : "AI 제안"}
          </span>
          <span className="truncate text-[12px] text-neutral-700 dark:text-neutral-200" title={summarize(ops)}>
            {summarize(ops)}
          </span>
          {/* Compact op-kind chips so the band hints WHAT changes without opening the chat. */}
          <span className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
            {ops.slice(0, 4).map((op, i) => (
              <span key={i} className="text-sm leading-none opacity-70" title={op.summary}>
                {OP_ICON[op.kind] ?? OP_ICON.edit}
              </span>
            ))}
          </span>
        </div>
        {/* The 3 inline actions — the PRIMARY review controls now (the chat card still mirrors them). */}
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={props.onConfirm}
            disabled={busy}
            title="이 제안을 문서에 확정합니다 (commit · ⌘Z 로 되돌리기)"
            className="rounded-md bg-ai px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            ✓ 확정
          </button>
          <button
            onClick={props.onReject}
            disabled={busy}
            title="이 제안을 버립니다 (discard)"
            className="rounded-md border border-black/10 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-200/70 disabled:opacity-40 dark:border-white/15 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
          >
            ✕ 취소
          </button>
          <button
            onClick={props.onRefine}
            disabled={busy}
            title="이 위치로 채팅을 열어 더 다듬거나 내용을 채웁니다"
            className="rounded-md border border-ai/30 px-3 py-1 text-xs text-ai hover:bg-ai/10 disabled:opacity-40"
          >
            ✎ 다시
          </button>
        </div>
      </div>
    </div>
  );
}
