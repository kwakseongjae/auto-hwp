/// Sanitize rhwp-produced SVG before it is injected via innerHTML (App.tsx). A malicious .hwp can
/// embed <script>, on* handlers, javascript: URIs, or <foreignObject> (arbitrary HTML) in its rendered
/// SVG — all of which would run in the webview. We parse the markup as SVG, walk the tree, and strip
/// the dangerous nodes/attrs, then re-serialize. Structural stripping (not regex) is robust against
/// attribute-injection. CSP is the second layer; this is defense-in-depth.

// Elements that can execute script, smuggle arbitrary HTML, or re-introduce a handler/URI by
// animating an attribute into existence (SMIL) — dropped wholesale, at any depth.
const FORBIDDEN_TAGS = new Set([
  "script",
  "foreignobject",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
]);
// URL-bearing attributes whose value must carry only a safe scheme.
const URI_ATTRS = ["href", "xlink:href", "src"];

function isDangerousUri(value: string): boolean {
  // Strip control chars/whitespace that can hide the scheme (e.g. "java\nscript:"), then test.
  const v = value.replace(/[\x00-\x20]+/g, "").toLowerCase();
  if (v.startsWith("javascript:") || v.startsWith("vbscript:")) return true;
  // data: is allowed ONLY for raster images (rhwp embeds PNG/JPEG); block data:text/html and
  // data:image/svg+xml (an SVG payload can itself carry script).
  if (v.startsWith("data:")) return !/^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/.test(v);
  return false;
}

/** Strip event-handler + dangerous-URI attributes from a single element (root included). */
function scrubAttrs(el: Element) {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name); // event handler
    } else if (URI_ATTRS.includes(name) && isDangerousUri(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
}

function scrub(el: Element) {
  // The element handed to us (incl. the root <svg>) is NOT exempt — scrub its own attributes first.
  scrubAttrs(el);
  // Snapshot children first: we mutate the tree (removing nodes) while walking.
  for (const child of Array.from(el.children)) {
    if (FORBIDDEN_TAGS.has(child.tagName.toLowerCase())) {
      child.remove();
      continue;
    }
    scrub(child);
  }
}

/** Return a sanitized copy of an SVG string safe to inject via innerHTML. */
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  // Parse error (or non-SVG root) → refuse to inject anything.
  if (!root || root.nodeName.toLowerCase() === "parsererror" || root.tagName.toLowerCase() !== "svg") {
    return "";
  }
  scrub(root);
  return new XMLSerializer().serializeToString(root);
}
