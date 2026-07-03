import type { EngineAdapter } from "./adapter";
import { EditController } from "./edit";
import { DocSession } from "./session";
import { SelectionModel } from "./selection";

/// EditorCore — the one-object composition of the three L2 pieces over a single EngineAdapter, so a host
/// (React binding or a plain script) constructs the whole headless editor in one line and subscribes to
/// its events. This is the object `@tf-hwp/react`'s `useHwpEditor(core)` hook wraps, and the object the
/// vanilla example drives with NO framework at all.
export class EditorCore {
  readonly session: DocSession;
  readonly selection: SelectionModel;
  readonly edit: EditController;

  constructor(readonly adapter: EngineAdapter) {
    this.session = new DocSession(adapter);
    this.selection = new SelectionModel(adapter);
    this.edit = new EditController(this.session, this.selection);
  }
}

/** Construct an EditorCore over an EngineAdapter. */
export function createEditorCore(adapter: EngineAdapter): EditorCore {
  return new EditorCore(adapter);
}
