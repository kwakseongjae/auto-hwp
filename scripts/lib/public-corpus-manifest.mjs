import { extname } from "node:path";
import { parseAllowedRedirectHostname, parsePublicHttpsUrl } from "./public-network-boundary.mjs";

const ROOT_KEYS = new Set(["schema_version", "policy", "artifacts"]);
const POLICY_KEYS = new Set(["binary_storage", "redistribution", "minimums"]);
const MINIMUM_KEYS = new Set(["hwp5", "hwpx", "official_pdf_pairs"]);
const ARTIFACT_KEYS = new Set([
  "id", "file", "format", "publisher", "kind", "source_page", "source_url",
  "allowed_redirect_hosts", "license", "retrieved_at", "sha256", "detected_magic",
  "size_bytes", "feature_tags", "pair_id", "privacy_review",
]);
const LICENSE_KEYS = new Set(["code", "evidence_url", "observed_at", "scope"]);
const PRIVACY_KEYS = new Set(["classification", "decision", "reviewed_at"]);
const FORMATS = new Set(["hwp5", "hwpx", "pdf"]);
const MAGIC_BY_FORMAT = new Map([
  ["hwp5", "hwp5-cfb"],
  ["hwpx", "hwpx-owpml-zip"],
  ["pdf", "pdf"],
]);
const EXTENSION_BY_FORMAT = new Map([["hwp5", ".hwp"], ["hwpx", ".hwpx"], ["pdf", ".pdf"]]);
const LICENSE_SCOPES = new Set([
  "statutory-public-domain",
  "license-as-observed-private-evaluation",
  "text-only-private-evaluation",
]);
const PRIVACY_CLASSES = new Set(["blank-form-template", "official-publication", "public-guidance"]);
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const APPROVED_OFFICIAL_HOSTS = new Set([
  "rda.go.kr",
  "www.kdca.go.kr",
  "www.korea.kr",
  "www.law.go.kr",
  "www.mafra.go.kr",
  "www.moe.go.kr",
  "www.mohw.go.kr",
  "www.nfa.go.kr",
]);

function exactKeys(value, keys, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: object required`);
    return false;
  }
  for (const key of Object.keys(value)) if (!keys.has(key)) errors.push(`${path}: unknown field ${key}`);
  for (const key of keys) if (!(key in value)) errors.push(`${path}: missing field ${key}`);
  return true;
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function realTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  return new Date(parsed).toISOString() === normalized;
}

function publicUrl(value, path, errors) {
  try {
    const url = parsePublicHttpsUrl(value, path);
    if (!APPROVED_OFFICIAL_HOSTS.has(url.hostname)) errors.push(`${path}: host is not in the reviewed official allowlist`);
    return url;
  }
  catch (error) { errors.push(error.message); return null; }
}

export function validatePublicCorpusManifest(doc, { enforceMinimums = true } = {}) {
  const errors = [];
  if (!exactKeys(doc, ROOT_KEYS, "manifest", errors)) return errors;
  if (doc.schema_version !== 1) errors.push("manifest.schema_version must be 1");
  if (exactKeys(doc.policy, POLICY_KEYS, "manifest.policy", errors)) {
    if (doc.policy.binary_storage !== "gitignored-private") errors.push("manifest.policy.binary_storage must be gitignored-private");
    if (doc.policy.redistribution !== "metadata-only") errors.push("manifest.policy.redistribution must be metadata-only");
    if (exactKeys(doc.policy.minimums, MINIMUM_KEYS, "manifest.policy.minimums", errors)) {
      if (doc.policy.minimums.hwp5 !== 20 || doc.policy.minimums.hwpx !== 20 || doc.policy.minimums.official_pdf_pairs !== 10) {
        errors.push("manifest.policy.minimums must be hwp5=20, hwpx=20, official_pdf_pairs=10");
      }
    }
  }
  if (!Array.isArray(doc.artifacts)) {
    errors.push("manifest.artifacts must be an array");
    return errors;
  }

  const ids = new Set();
  const files = new Set();
  const urls = new Set();
  const hashes = new Set();
  const pairs = new Map();
  let previousId = "";
  const counts = { hwp5: 0, hwpx: 0, pdf: 0 };

  for (const [index, artifact] of doc.artifacts.entries()) {
    const path = `manifest.artifacts[${index}]`;
    if (!exactKeys(artifact, ARTIFACT_KEYS, path, errors)) continue;
    if (typeof artifact.id !== "string" || !SLUG.test(artifact.id)) errors.push(`${path}.id: lowercase slug required`);
    else {
      if (artifact.id <= previousId) errors.push(`${path}.id: artifacts must be strictly sorted`);
      previousId = artifact.id;
      if (ids.has(artifact.id)) errors.push(`${path}.id: duplicate`);
      ids.add(artifact.id);
    }
    if (!FORMATS.has(artifact.format)) errors.push(`${path}.format: hwp5, hwpx, or pdf required`);
    else counts[artifact.format]++;
    if (typeof artifact.file !== "string" || artifact.file !== `${artifact.id}${EXTENSION_BY_FORMAT.get(artifact.format) ?? ""}`) {
      errors.push(`${path}.file: deterministic id plus format extension required`);
    } else {
      if (files.has(artifact.file.toLowerCase())) errors.push(`${path}.file: duplicate`);
      files.add(artifact.file.toLowerCase());
    }
    if (![artifact.publisher, artifact.kind].every((value) => typeof value === "string" && value.trim())) errors.push(`${path}: publisher and kind required`);
    publicUrl(artifact.source_page, `${path}.source_page`, errors);
    publicUrl(artifact.source_url, `${path}.source_url`, errors);
    if (urls.has(artifact.source_url)) errors.push(`${path}.source_url: duplicate`);
    urls.add(artifact.source_url);
    if (!Array.isArray(artifact.allowed_redirect_hosts)) errors.push(`${path}.allowed_redirect_hosts: array required`);
    else {
      const normalized = [];
      for (const [hostIndex, host] of artifact.allowed_redirect_hosts.entries()) {
        try {
          const normalizedHost = parseAllowedRedirectHostname(host, `${path}.allowed_redirect_hosts[${hostIndex}]`);
          normalized.push(normalizedHost);
          if (!APPROVED_OFFICIAL_HOSTS.has(normalizedHost)) errors.push(`${path}.allowed_redirect_hosts[${hostIndex}]: host is not in the reviewed official allowlist`);
        }
        catch (error) { errors.push(error.message); }
      }
      if (new Set(normalized).size !== normalized.length || [...normalized].sort().join("\0") !== normalized.join("\0")) errors.push(`${path}.allowed_redirect_hosts: sorted unique hosts required`);
    }
    if (exactKeys(artifact.license, LICENSE_KEYS, `${path}.license`, errors)) {
      if (typeof artifact.license.code !== "string" || !artifact.license.code.trim()) errors.push(`${path}.license.code required`);
      publicUrl(artifact.license.evidence_url, `${path}.license.evidence_url`, errors);
      if (!realDate(artifact.license.observed_at)) errors.push(`${path}.license.observed_at: real date required`);
      if (!LICENSE_SCOPES.has(artifact.license.scope)) errors.push(`${path}.license.scope: approved private-evaluation scope required`);
    }
    if (!realTimestamp(artifact.retrieved_at)) errors.push(`${path}.retrieved_at: UTC RFC3339 timestamp required`);
    if (!SHA256.test(String(artifact.sha256 ?? ""))) errors.push(`${path}.sha256: lowercase SHA-256 required`);
    else {
      if (hashes.has(artifact.sha256)) errors.push(`${path}.sha256: duplicate content`);
      hashes.add(artifact.sha256);
    }
    if (artifact.detected_magic !== MAGIC_BY_FORMAT.get(artifact.format)) errors.push(`${path}.detected_magic: format mismatch`);
    if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 1 || artifact.size_bytes > 64 * 1024 * 1024) errors.push(`${path}.size_bytes: 1..67108864 required`);
    if (!Array.isArray(artifact.feature_tags) || artifact.feature_tags.length < 1 || artifact.feature_tags.some((tag) => typeof tag !== "string" || !SLUG.test(tag)) || new Set(artifact.feature_tags).size !== artifact.feature_tags.length || [...artifact.feature_tags].sort().join("\0") !== artifact.feature_tags.join("\0")) errors.push(`${path}.feature_tags: sorted unique lowercase slugs required`);
    if (artifact.pair_id !== null && (typeof artifact.pair_id !== "string" || !SLUG.test(artifact.pair_id))) errors.push(`${path}.pair_id: null or lowercase slug required`);
    if (artifact.pair_id !== null) {
      const members = pairs.get(artifact.pair_id) ?? [];
      members.push(artifact);
      pairs.set(artifact.pair_id, members);
    }
    if (exactKeys(artifact.privacy_review, PRIVACY_KEYS, `${path}.privacy_review`, errors)) {
      if (!PRIVACY_CLASSES.has(artifact.privacy_review.classification)) errors.push(`${path}.privacy_review.classification: approved public class required`);
      if (artifact.privacy_review.decision !== "include") errors.push(`${path}.privacy_review.decision must be include`);
      if (!realDate(artifact.privacy_review.reviewed_at)) errors.push(`${path}.privacy_review.reviewed_at: real date required`);
    }
  }

  let officialPdfPairs = 0;
  for (const [pairId, members] of pairs) {
    const formats = new Set(members.map((member) => member.format));
    if (formats.has("pdf") && (formats.has("hwp5") || formats.has("hwpx"))) {
      officialPdfPairs++;
      if (new Set(members.map((member) => member.source_page)).size !== 1) errors.push(`pair ${pairId}: source_page must match`);
    }
  }
  if (enforceMinimums && (counts.hwp5 < 20 || counts.hwpx < 20 || officialPdfPairs < 10)) {
    errors.push(`manifest minimums unmet: hwp5=${counts.hwp5}, hwpx=${counts.hwpx}, official_pdf_pairs=${officialPdfPairs}`);
  }
  return errors;
}

export function loadPublicCorpusManifest(jsonText, options) {
  const doc = JSON.parse(jsonText);
  const errors = validatePublicCorpusManifest(doc, options);
  if (errors.length) throw new Error(`public-corpus manifest invalid:\n- ${errors.join("\n- ")}`);
  return doc;
}

export function summarizePublicCorpus(doc) {
  const formats = { hwp5: 0, hwpx: 0, pdf: 0 };
  const pairs = new Map();
  for (const artifact of doc.artifacts) {
    formats[artifact.format]++;
    if (artifact.pair_id) {
      const set = pairs.get(artifact.pair_id) ?? new Set();
      set.add(artifact.format);
      pairs.set(artifact.pair_id, set);
    }
  }
  return { artifacts: doc.artifacts.length, formats, official_pdf_pairs: [...pairs.values()].filter((set) => set.has("pdf") && (set.has("hwp5") || set.has("hwpx"))).length };
}
