// vitest setup — jsdom (as of v25) ships no `PointerEvent` and no `setPointerCapture`, so the
// selection model's pointer handlers (issue 021) never fire under test. Polyfill both minimally: a
// PointerEvent that extends MouseEvent (so clientX/button/buttons/metaKey/ctrlKey all work) plus no-op
// pointer-capture methods. Real browsers (Playwright smoke) exercise the genuine APIs.

if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public isPrimary: boolean;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const proto = Element.prototype as unknown as Record<string, unknown>;
if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = () => {};
if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = () => {};
if (typeof proto.hasPointerCapture !== "function") proto.hasPointerCapture = () => false;
