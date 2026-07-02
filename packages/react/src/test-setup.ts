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

// jsdom doesn't implement URL.createObjectURL/revokeObjectURL (the font @font-face injection, issue
// 022, builds a blob: URL for the selected face). Stub both so the workspace font flow runs in tests.
const urlObj = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
if (typeof urlObj.createObjectURL !== "function") urlObj.createObjectURL = () => "blob:tfhwp-test";
if (typeof urlObj.revokeObjectURL !== "function") urlObj.revokeObjectURL = () => {};

// jsdom's Blob/File (v25) ship no `arrayBuffer()` — the FontPicker reads uploaded font bytes via
// `file.arrayBuffer()`. Polyfill it through FileReader (which jsdom does implement).
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}
