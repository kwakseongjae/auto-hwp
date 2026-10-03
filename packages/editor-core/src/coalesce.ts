/// TypingCoalescer — decides which consecutive keystrokes share ONE undo step (issue #369).
///
/// A caret controller asks `keyFor(target, at, text)` before each typing commit. Keystrokes that land
/// at the expected next position of the SAME target (a cell / paragraph address) get the same key, so
/// `DocSession.applyBatch(…, { coalesceKey })` folds them into the top undo batch. A new key (= a new
/// undo step) starts when:
///  - the target changes, or the caret is not where the previous keystroke left it (click / arrow);
///  - a whitespace run begins after a word (`"ab c"` → steps `"ab"` and `" c"` — word-level undo);
///  - the text contains a line break (Enter is its own step) — then no key is returned at all.
/// Any non-typing commit (paste, Backspace, style toggle, Enter) must call `reset()`. The time window
/// (a pause) lives in `DocSession`, which owns the clock.
export class TypingCoalescer {
  private serial = 0;
  private target: string | null = null;
  private nextAt = -1;
  private lastWasSpace = false;

  /** The coalesce key for inserting `text` at offset `at` of `target`, or `undefined` when this
   *  insertion must be its own undo step. Offsets are the caller's own units (UTF-16 here). */
  keyFor(target: string, at: number, text: string): string | undefined {
    if (text.length === 0 || /[\r\n]/.test(text)) {
      this.reset();
      return undefined;
    }
    const startsSpace = /^\s/u.test(text);
    if (target !== this.target || at !== this.nextAt || (startsSpace && !this.lastWasSpace)) this.serial++;
    this.target = target;
    this.nextAt = at + text.length;
    this.lastWasSpace = /\s$/u.test(text);
    return `typing:${target}:${this.serial}`;
  }

  /** End the current typing run (the next keystroke starts a new undo step). */
  reset(): void {
    this.target = null;
    this.nextAt = -1;
    this.lastWasSpace = false;
  }
}
