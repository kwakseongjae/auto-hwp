import { Emitter } from "@tf-hwp/editor-core";

/// A live IME composition, as seen by the React overlay layer (issue 059). This is a DOM/React concern —
/// composition events fire on the caret-tracking hidden textarea, NOT in the headless engine — so the
/// store lives here, not in editor-core (엔진 무변경). At most ONE composition is in flight at a time.
export interface ImeComposition {
  /** The own-render page the caret (and thus the composing text) sits on. */
  page: number;
  /** The current composing string (`compositionupdate.data`) — the transient, pre-commit text. */
  text: string;
}

/// CompositionStore — the tiny shared signal between the ImeCompositionLayer (which owns the textarea and
/// drives composition) and the CaretLayer (which HIDES its blinking bar while a composition is live, so the
/// composition's own caret bar at the string's right edge is the only one shown — no double caret). It
/// mirrors the `HoverStore` pattern: a plain emitter with a current value, subscribed to directly by the
/// isolated overlay layers (render path stays decoupled from the workspace).
export class CompositionStore {
  private cur: ImeComposition | null = null;
  private changed = new Emitter<ImeComposition | null>();

  get(): ImeComposition | null {
    return this.cur;
  }

  /** True while a composition is live on `page` (CaretLayer reads this to suppress its caret). */
  composingOn(page: number): boolean {
    return this.cur?.page === page;
  }

  /** Replace the live composition (or clear it with `null`). Emits only on a MEANINGFUL change so a
   *  same-value update never churns subscribers — presence flips (start/end) and text edits both count,
   *  but a redundant `null→null` is swallowed. */
  set(next: ImeComposition | null): void {
    const a = this.cur;
    if (a === next) return;
    if (a && next && a.page === next.page && a.text === next.text) return;
    this.cur = next;
    this.changed.emit(next);
  }

  onChange(l: (c: ImeComposition | null) => void): () => void {
    return this.changed.on(l);
  }
}
