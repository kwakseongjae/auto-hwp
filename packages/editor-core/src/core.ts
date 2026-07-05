import type { EngineAdapter } from "./adapter";
import { EditController } from "./edit";
import { FindController } from "./find";
import { DocSession } from "./session";
import { SelectionModel } from "./selection";

/// EditorCore — the one-object composition of the L2 pieces over a single EngineAdapter, so a host
/// (React binding or a plain script) constructs the whole headless editor in one line and subscribes to
/// its events. This is the object `@tf-hwp/react`'s `useHwpEditor(core)` hook wraps, and the object the
/// vanilla example drives with NO framework at all.
export class EditorCore {
  readonly session: DocSession;
  readonly selection: SelectionModel;
  readonly edit: EditController;
  /** 찾기/바꾸기 controller (issue 045) — needs the session so its replace records a coherent undo unit. */
  readonly find: FindController;

  constructor(readonly adapter: EngineAdapter) {
    this.session = new DocSession(adapter);
    this.selection = new SelectionModel(adapter);
    this.edit = new EditController(this.session, this.selection);
    this.find = new FindController(adapter, this.session);
  }
}

/** Construct an EditorCore over an EngineAdapter. */
export function createEditorCore(adapter: EngineAdapter): EditorCore {
  return new EditorCore(adapter);
}
