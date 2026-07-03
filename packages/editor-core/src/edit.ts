import { describeIntent } from "./describeIntent";
import type { DocSession } from "./session";
import type { SelectionModel } from "./selection";
import type { DocContext, Intent, IntentCard } from "./types";

/// EditController — Intent assembly + apply + preview gate (SDK-LAYERS L2). It joins the DocSession and
/// the SelectionModel: it builds the read-only DocContext (doc meta + the marked anchors) handed to the
/// host AI callback, previews Intents as per-op cards, and APPLIES a proposal as one undo batch (then
/// clears the consumed selection). The AI itself is delegated to the host (R6) — this controller never
/// calls an LLM; it only prepares the request and commits the returned Intents.
export class EditController {
  constructor(
    private session: DocSession,
    private selection: SelectionModel,
  ) {}

  /** The read-only DocContext for the current selection (doc meta + marked anchors). */
  docContext(): DocContext {
    return this.session.docContext(this.selection.getAnchors());
  }

  /** Map proposed Intents → preview cards (icon + label + human summary + target chip). */
  preview(intents: Intent[]): IntentCard[] {
    return intents.map(describeIntent);
  }

  /** Apply a previewed proposal as ONE undo batch, then clear the consumed selection. Resolves to how
   *  many ops were applied. Rethrows on failure (the UI surfaces the error / trap-recovery message). */
  async apply(intents: Intent[]): Promise<number> {
    const applied = await this.session.applyBatch(intents);
    this.selection.clear();
    return applied;
  }
}
