import { extname } from "node:path";

const EXACT_KOGL = /^KOGL-[01]$/;
const EXACT_SHA256 = /^[0-9a-f]{64}$/i;
const DOCUMENT_EXTENSIONS = new Set([".hwp", ".hwpx"]);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MANIFEST_KEYS = new Set(["schema_version", "note", "files"]);
const FILE_KEYS = new Set([
  "file",
  "publisher",
  "kind",
  "kogl",
  "kogl_verified",
  "kogl_measured_on",
  "kogl_quote",
  "source_page",
  "source_url",
  "sha256",
]);

function realIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requirePublicHttps(value, field, index) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`gov-sources files[${index}].${field}: valid URL required`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`gov-sources files[${index}].${field}: HTTPS without credentials required`);
  }
}

function requirePortableDocumentName(value, index) {
  const label = `gov-sources files[${index}].file`;
  if (typeof value !== "string" || !value) throw new Error(`${label}: filename required`);
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`${label}: basename only (both slash styles are forbidden)`);
  }
  if (/[\u0000-\u001f\u007f<>:"|?*]/u.test(value)) {
    throw new Error(`${label}: portable filename characters required`);
  }
  if (value.endsWith(".") || value.endsWith(" ") || WINDOWS_DEVICE_NAME.test(value)) {
    throw new Error(`${label}: Windows-compatible filename required`);
  }
  if (Buffer.byteLength(value, "utf8") > 240 || value.length > 240) {
    throw new Error(`${label}: filename is too long`);
  }
  if (value !== value.normalize("NFC")) {
    throw new Error(`${label}: NFC-normalized name required`);
  }
  if (!DOCUMENT_EXTENSIONS.has(extname(value).toLowerCase())) {
    throw new Error(`${label}: .hwp or .hwpx required`);
  }
}

/**
 * Shared GOV-SOURCES loader (issues #71/#92).
 *
 * This is an executable download allowlist. Reject the whole manifest before filesystem or network
 * I/O instead of silently filtering malformed rows.
 */
export function loadGovSources(jsonText) {
  const manifest = JSON.parse(jsonText);
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("gov-sources: schema_version=1 and files[] are required");
  }
  const unknownManifestKey = Object.keys(manifest).find((key) => !MANIFEST_KEYS.has(key));
  if (unknownManifestKey) throw new Error(`gov-sources: unknown field ${unknownManifestKey}`);

  const names = new Set();
  const sources = new Set();
  return manifest.files.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`gov-sources files[${index}]: object required`);
    }
    const unknownItemKey = Object.keys(item).find((key) => !FILE_KEYS.has(key));
    if (unknownItemKey) {
      throw new Error(`gov-sources files[${index}]: unknown field ${unknownItemKey}`);
    }

    requirePortableDocumentName(item.file, index);
    const nameKey = item.file.toLowerCase();
    if (names.has(nameKey)) {
      throw new Error(`gov-sources files[${index}].file: duplicate ${item.file}`);
    }
    names.add(nameKey);

    if (item.kogl_verified !== true || !EXACT_KOGL.test(String(item.kogl ?? ""))) {
      throw new Error(`gov-sources files[${index}].kogl: verified exact KOGL-0/1 required`);
    }
    if (item.kogl_measured_on !== undefined || item.kogl_quote !== undefined) {
      if (
        !realIsoDate(item.kogl_measured_on) ||
        typeof item.kogl_quote !== "string" ||
        !item.kogl_quote.trim()
      ) {
        throw new Error(
          `gov-sources files[${index}]: measured KOGL evidence requires a real date and quote`,
        );
      }
    }
    if (!EXACT_SHA256.test(String(item.sha256 ?? ""))) {
      throw new Error(`gov-sources files[${index}].sha256: full SHA-256 required`);
    }
    if (typeof item.publisher !== "string" || !item.publisher.trim()) {
      throw new Error(`gov-sources files[${index}].publisher: non-empty string required`);
    }
    if (typeof item.kind !== "string" || !item.kind.trim()) {
      throw new Error(`gov-sources files[${index}].kind: non-empty string required`);
    }

    requirePublicHttps(item.source_page, "source_page", index);
    requirePublicHttps(item.source_url, "source_url", index);
    if (sources.has(item.source_url)) {
      throw new Error(`gov-sources files[${index}].source_url: duplicate URL`);
    }
    sources.add(item.source_url);
    return item;
  });
}
