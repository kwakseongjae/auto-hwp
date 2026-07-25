import type { EngineAdapter } from "./adapter";
import { BodyCaretController } from "./bodyCaret";
import { CaretRouter } from "./caretRouter";
import { CellCaretController } from "./cellCaret";
import { EditController } from "./edit";
import { FindController } from "./find";
import { DocSession } from "./session";
import { SelectionModel } from "./selection";

/// EditorCore — the one-object composition of the L2 pieces over a single EngineAdapter, so a host
/// (React binding or a plain script) constructs the whole headless editor in one line and subscribes to
/// its events. This is the object `@auto-hwp/react`'s `useHwpEditor(core)` hook wraps, and the object the
/// vanilla example drives with NO framework at all.
export class EditorCore {
  readonly session: DocSession;
  readonly selection: SelectionModel;
  readonly edit: EditController;
  /** 찾기/바꾸기 controller (issue 045) — needs the session so its replace records a coherent undo unit. */
  readonly find: FindController;
  /** Cell-addressed glyph caret (issue 053) — click → caret → per-keystroke `SetTableCellRuns` commits
   *  through the session (one undo unit per keystroke; layout invalidation stays coherent with every
   *  other edit lane). Inert when the adapter lacks the cell caret queries (`cellCaret.supported`). */
  readonly cellCaret: CellCaretController;
  /** 본문 문단 캐럿 — 셀 밖 문단을 클릭해 타이핑하는 절반(CARET-GAP §7.4의 남은 갭). 기하는 화면에
   *  주입되는 바로 그 페이지 SVG에서, 커밋은 `SetParagraphRuns`로. 어댑터가 `blockRuns`를 안 내면 비활성. */
  readonly bodyCaret: BodyCaretController;
  /** 살아 있는 캐럿 하나(셀 ∪ 본문) — 오버레이/타이핑이 구독하는 단일 표면. */
  readonly caret: CaretRouter;

  constructor(readonly adapter: EngineAdapter) {
    this.session = new DocSession(adapter);
    this.selection = new SelectionModel(adapter);
    this.edit = new EditController(this.session, this.selection);
    this.find = new FindController(adapter, this.session);
    this.cellCaret = new CellCaretController(adapter, this.session);
    this.bodyCaret = new BodyCaretController(adapter, this.session);
    this.caret = new CaretRouter(this.cellCaret, this.bodyCaret);
  }
}

/** Construct an EditorCore over an EngineAdapter. */
export function createEditorCore(adapter: EngineAdapter): EditorCore {
  return new EditorCore(adapter);
}
