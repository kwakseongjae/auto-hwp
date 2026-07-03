/// A minimal, framework-agnostic event emitter. Deliberately NOT the DOM `EventTarget` (SDK-LAYERS: L2
/// carries zero DOM) — just a typed listener set, so the same core drives a React `useState`
/// subscription, a Solid signal, or a plain `console.log` in a node script.

export type Listener<T> = (value: T) => void;

/** A single-payload event channel. `on` returns an unsubscribe function. */
export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  /** Subscribe; returns an unsubscribe function (idempotent). */
  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notify every current subscriber. Iterates a snapshot so a listener may unsubscribe mid-emit. */
  emit(value: T): void {
    for (const listener of Array.from(this.listeners)) listener(value);
  }

  /** Drop all subscribers (used on teardown). */
  clear(): void {
    this.listeners.clear();
  }
}
