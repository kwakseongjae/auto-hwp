import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize, sep } from "node:path";

const ROOT_KEYS = new Set(["schema_version", "policy", "pairs"]);
const POLICY_KEYS = new Set(["mode", "quality_threshold", "minimum_trusted_pairs", "candidate_font", "raster"]);
const CANDIDATE_FONT_KEYS = new Set(["file", "sha256"]);
const RASTER_KEYS = new Set(["dpi", "max_translation_px", "scale", "crop", "rotation_degrees"]);
const PAIR_KEYS = new Set(["pair_id", "source", "reference"]);
const SOURCE_KEYS = new Set(["artifact_id", "file", "format", "sha256"]);
const REFERENCE_KEYS = new Set([
  "file", "tier", "source_page", "source_url", "sha256", "size_bytes", "license",
  "product", "build", "os", "font_fingerprint", "note",
]);
const LICENSE_KEYS = new Set(["code", "evidence_url", "observed_at", "scope"]);
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function exactKeys(value, expected, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}: object required`);
    return false;
  }
  for (const key of Object.keys(value)) if (!expected.has(key)) errors.push(`${path}: unknown field ${key}`);
  for (const key of expected) if (!(key in value)) errors.push(`${path}: missing field ${key}`);
  return true;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRelativeFile(value, extension, path, errors) {
  if (!nonempty(value) || isAbsolute(value) || basename(value) !== value || normalize(value).split(sep).includes("..") || !value.endsWith(extension)) {
    errors.push(`${path}: safe ${extension} basename required`);
  }
}

function officialHttps(value, path, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname !== "www.law.go.kr") {
      errors.push(`${path}: reviewed https://www.law.go.kr URL required`);
    }
  } catch {
    errors.push(`${path}: valid URL required`);
  }
}

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validatePdfCalibrationManifest(doc, publicCorpus = null) {
  const errors = [];
  if (!exactKeys(doc, ROOT_KEYS, "manifest", errors)) return errors;
  if (doc.schema_version !== 1) errors.push("manifest.schema_version must be 1");

  if (exactKeys(doc.policy, POLICY_KEYS, "manifest.policy", errors)) {
    if (doc.policy.mode !== "report-only") errors.push("manifest.policy.mode must be report-only");
    if (doc.policy.quality_threshold !== null) errors.push("manifest.policy.quality_threshold must remain null during calibration");
    if (doc.policy.minimum_trusted_pairs !== 20) errors.push("manifest.policy.minimum_trusted_pairs must be 20");
    if (exactKeys(doc.policy.candidate_font, CANDIDATE_FONT_KEYS, "manifest.policy.candidate_font", errors)) {
      const font = doc.policy.candidate_font;
      if (!nonempty(font.file) || isAbsolute(font.file) || normalize(font.file).split(sep).includes("..")) errors.push("manifest.policy.candidate_font.file: safe repository-relative path required");
      if (!SHA256.test(String(font.sha256 ?? ""))) errors.push("manifest.policy.candidate_font.sha256: lowercase SHA-256 required");
    }
    if (exactKeys(doc.policy.raster, RASTER_KEYS, "manifest.policy.raster", errors)) {
      const raster = doc.policy.raster;
      if (raster.dpi !== 144 || raster.max_translation_px !== 3 || raster.scale !== 1 || raster.crop !== false || raster.rotation_degrees !== 0) {
        errors.push("manifest.policy.raster must pin 144 DPI, ±3px translation, scale=1, crop=false, rotation=0");
      }
    }
  }

  if (!Array.isArray(doc.pairs)) {
    errors.push("manifest.pairs must be an array");
    return errors;
  }
  if (doc.pairs.length !== 20) errors.push(`manifest.pairs must contain exactly 20 trusted pairs (got ${doc.pairs.length})`);

  const publicArtifacts = new Map(publicCorpus?.artifacts?.map((artifact) => [artifact.id, artifact]) ?? []);
  const ids = new Set();
  const sourceHashes = new Set();
  const referenceHashes = new Set();
  const referenceUrls = new Set();
  let previousPairId = "";

  for (const [index, pair] of doc.pairs.entries()) {
    const path = `manifest.pairs[${index}]`;
    if (!exactKeys(pair, PAIR_KEYS, path, errors)) continue;
    if (!SLUG.test(String(pair.pair_id ?? ""))) errors.push(`${path}.pair_id: lowercase slug required`);
    if (pair.pair_id <= previousPairId) errors.push(`${path}.pair_id: pairs must be strictly sorted`);
    previousPairId = pair.pair_id;
    if (ids.has(pair.pair_id)) errors.push(`${path}.pair_id: duplicate`);
    ids.add(pair.pair_id);

    if (exactKeys(pair.source, SOURCE_KEYS, `${path}.source`, errors)) {
      if (pair.source.artifact_id !== `${pair.pair_id}-hwp5`) errors.push(`${path}.source.artifact_id: must match pair_id`);
      safeRelativeFile(pair.source.file, ".hwp", `${path}.source.file`, errors);
      if (pair.source.format !== "hwp5") errors.push(`${path}.source.format must be hwp5`);
      if (!SHA256.test(String(pair.source.sha256 ?? ""))) errors.push(`${path}.source.sha256: lowercase SHA-256 required`);
      if (sourceHashes.has(pair.source.sha256)) errors.push(`${path}.source.sha256: duplicate`);
      sourceHashes.add(pair.source.sha256);

      const artifact = publicArtifacts.get(pair.source.artifact_id);
      if (publicCorpus && !artifact) errors.push(`${path}.source.artifact_id: missing from public corpus manifest`);
      if (artifact && (artifact.file !== pair.source.file || artifact.format !== pair.source.format || artifact.sha256 !== pair.source.sha256 || artifact.pair_id !== pair.pair_id)) {
        errors.push(`${path}.source: does not match public corpus artifact`);
      }
    }

    if (exactKeys(pair.reference, REFERENCE_KEYS, `${path}.reference`, errors)) {
      const reference = pair.reference;
      if (reference.file !== `${pair.pair_id}-pdf.pdf`) errors.push(`${path}.reference.file: must match pair_id`);
      safeRelativeFile(reference.file, ".pdf", `${path}.reference.file`, errors);
      if (!new Set(["T0", "T1"]).has(reference.tier)) errors.push(`${path}.reference.tier: T0 or T1 required`);
      officialHttps(reference.source_page, `${path}.reference.source_page`, errors);
      officialHttps(reference.source_url, `${path}.reference.source_url`, errors);
      if (referenceUrls.has(reference.source_url)) errors.push(`${path}.reference.source_url: duplicate`);
      referenceUrls.add(reference.source_url);
      if (!SHA256.test(String(reference.sha256 ?? ""))) errors.push(`${path}.reference.sha256: lowercase SHA-256 required`);
      if (referenceHashes.has(reference.sha256)) errors.push(`${path}.reference.sha256: duplicate`);
      referenceHashes.add(reference.sha256);
      if (!Number.isSafeInteger(reference.size_bytes) || reference.size_bytes < 1 || reference.size_bytes > 64 * 1024 * 1024) errors.push(`${path}.reference.size_bytes: 1..67108864 required`);
      for (const field of ["product", "build", "os", "font_fingerprint", "note"]) {
        if (!nonempty(reference[field])) errors.push(`${path}.reference.${field}: explicit provenance required`);
      }
      if (!/^pdffonts-normalized-sha256:[0-9a-f]{64}$/.test(String(reference.font_fingerprint ?? ""))) errors.push(`${path}.reference.font_fingerprint: normalized pdffonts SHA-256 required`);
      if (!reference.note.includes(pair.pair_id) || !reference.note.includes("self-attested")) errors.push(`${path}.reference.note: pair_id and self-attested association required`);
      if (exactKeys(reference.license, LICENSE_KEYS, `${path}.reference.license`, errors)) {
        if (!nonempty(reference.license.code)) errors.push(`${path}.reference.license.code required`);
        officialHttps(reference.license.evidence_url, `${path}.reference.license.evidence_url`, errors);
        if (!realDate(reference.license.observed_at)) errors.push(`${path}.reference.license.observed_at: real date required`);
        if (reference.license.scope !== "statutory-public-domain") errors.push(`${path}.reference.license.scope must be statutory-public-domain`);
      }

      const artifact = publicArtifacts.get(pair.source?.artifact_id);
      if (artifact && artifact.source_page !== reference.source_page) errors.push(`${path}: HWP and PDF source_page must match`);
    }
  }
  return errors;
}

export function loadPdfCalibrationManifest(jsonText, publicCorpus = null) {
  const doc = JSON.parse(jsonText);
  const errors = validatePdfCalibrationManifest(doc, publicCorpus);
  if (errors.length) throw new Error(`PDF calibration manifest invalid:\n- ${errors.join("\n- ")}`);
  return doc;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const BASELINE_ROOT_KEYS = new Set(["schema_version", "manifest_sha256", "calibration", "environment", "counts", "pairs"]);
const BASELINE_CALIBRATION_KEYS = new Set(["engine_commit", "cli_features", "observed_at", "mode", "quality_threshold"]);
const BASELINE_ENVIRONMENT_KEYS = new Set([
  "pdfinfo", "pdftoppm", "platform_system", "platform_release", "platform_machine",
  "python_implementation", "python_version", "dpi", "candidate_font_fingerprint", "alignment",
]);
const BASELINE_ALIGNMENT_KEYS = new Set(["max_abs_translation_px", "scale", "crop", "rotation_degrees"]);
const BASELINE_COUNT_KEYS = new Set(["trusted_pairs", "scored_reports", "structural_mismatches", "scored_pages"]);
const BASELINE_PAIR_KEYS = new Set([
  "pair_id", "status", "source_sha256", "reference_sha256", "candidate_sha256",
  "reference_page_count", "candidate_page_count", "structural_mismatches", "scored_pages",
  "worst_page", "worst_tile",
]);
const WORST_PAGE_KEYS = new Set([
  "page", "global_ssim_like", "local_ssim_like_mean", "ink_f1", "edge_f1", "worst_tile_recall",
]);

function finiteUnitInterval(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

export function validatePdfCalibrationBaseline(doc, manifest, manifestSha256) {
  const errors = [];
  if (!exactKeys(doc, BASELINE_ROOT_KEYS, "baseline", errors)) return errors;
  if (doc.schema_version !== 1) errors.push("baseline.schema_version must be 1");
  if (doc.manifest_sha256 !== manifestSha256) errors.push("baseline.manifest_sha256 does not match the committed manifest bytes");
  if (exactKeys(doc.calibration, BASELINE_CALIBRATION_KEYS, "baseline.calibration", errors)) {
    if (!/^[0-9a-f]{7,40}$/.test(String(doc.calibration.engine_commit ?? ""))) errors.push("baseline.calibration.engine_commit: git SHA required");
    if (JSON.stringify(doc.calibration.cli_features) !== JSON.stringify(["pdf", "rhwp", "shaper"])) errors.push("baseline.calibration.cli_features must pin pdf/rhwp/shaper");
    if (!realDate(doc.calibration.observed_at)) errors.push("baseline.calibration.observed_at: real date required");
    if (doc.calibration.mode !== "report-only" || doc.calibration.quality_threshold !== null) errors.push("baseline.calibration must remain report-only with null threshold");
  }
  if (exactKeys(doc.environment, BASELINE_ENVIRONMENT_KEYS, "baseline.environment", errors)) {
    for (const field of ["pdfinfo", "pdftoppm", "platform_system", "platform_release", "platform_machine", "python_implementation", "python_version"]) {
      if (!nonempty(doc.environment[field])) errors.push(`baseline.environment.${field} required`);
    }
    if (doc.environment.dpi !== manifest.policy.raster.dpi) errors.push("baseline.environment.dpi: manifest mismatch");
    if (doc.environment.candidate_font_fingerprint !== `sha256:${manifest.policy.candidate_font.sha256}`) errors.push("baseline.environment.candidate_font_fingerprint: manifest mismatch");
    if (exactKeys(doc.environment.alignment, BASELINE_ALIGNMENT_KEYS, "baseline.environment.alignment", errors)) {
      const alignment = doc.environment.alignment;
      if (alignment.max_abs_translation_px !== 3 || alignment.scale !== 1 || alignment.crop !== false || alignment.rotation_degrees !== 0) errors.push("baseline.environment.alignment: forbidden normalization or unbounded translation");
    }
  }
  if (exactKeys(doc.counts, BASELINE_COUNT_KEYS, "baseline.counts", errors)) {
    for (const key of BASELINE_COUNT_KEYS) if (!Number.isSafeInteger(doc.counts[key]) || doc.counts[key] < 0) errors.push(`baseline.counts.${key}: nonnegative integer required`);
  }
  if (!Array.isArray(doc.pairs) || doc.pairs.length !== 20) {
    errors.push("baseline.pairs must contain exactly 20 entries");
    return errors;
  }
  const manifestPairs = new Map(manifest.pairs.map((pair) => [pair.pair_id, pair]));
  let scoredReports = 0;
  let structuralMismatches = 0;
  let scoredPages = 0;
  let previousPairId = "";
  for (const [index, pair] of doc.pairs.entries()) {
    const path = `baseline.pairs[${index}]`;
    if (!exactKeys(pair, BASELINE_PAIR_KEYS, path, errors)) continue;
    if (pair.pair_id <= previousPairId) errors.push(`${path}.pair_id: pairs must be strictly sorted`);
    previousPairId = pair.pair_id;
    const contract = manifestPairs.get(pair.pair_id);
    if (!contract) errors.push(`${path}.pair_id: absent from manifest`);
    else if (pair.source_sha256 !== contract.source.sha256 || pair.reference_sha256 !== contract.reference.sha256) errors.push(`${path}: source/reference hash mismatch`);
    if (!SHA256.test(String(pair.candidate_sha256 ?? ""))) errors.push(`${path}.candidate_sha256: lowercase SHA-256 required`);
    if (!new Set(["scored_report", "structural_mismatch"]).has(pair.status)) errors.push(`${path}.status: scored_report or structural_mismatch required`);
    for (const field of ["reference_page_count", "candidate_page_count", "scored_pages"]) if (!Number.isSafeInteger(pair[field]) || pair[field] < 0) errors.push(`${path}.${field}: nonnegative integer required`);
    if (!Array.isArray(pair.structural_mismatches)) errors.push(`${path}.structural_mismatches: array required`);
    if (pair.status === "structural_mismatch") {
      structuralMismatches++;
      if (pair.scored_pages !== 0 || pair.worst_page !== null || pair.worst_tile !== null || pair.structural_mismatches.length === 0) errors.push(`${path}: structural mismatch must not carry pixel scores`);
    } else {
      scoredReports++;
      if (pair.structural_mismatches.length !== 0 || pair.scored_pages < 1 || !pair.worst_page || !pair.worst_tile) errors.push(`${path}: scored report requires pixel diagnostics and no structural mismatch`);
      if (pair.worst_page && exactKeys(pair.worst_page, WORST_PAGE_KEYS, `${path}.worst_page`, errors)) {
        for (const metric of ["global_ssim_like", "local_ssim_like_mean", "ink_f1", "edge_f1"]) if (!finiteUnitInterval(pair.worst_page[metric])) errors.push(`${path}.worst_page.${metric}: finite normalized metric required`);
        if (pair.worst_page.worst_tile_recall !== null && !finiteUnitInterval(pair.worst_page.worst_tile_recall)) errors.push(`${path}.worst_page.worst_tile_recall: null or finite normalized metric required`);
      }
    }
    scoredPages += pair.scored_pages;
  }
  if (doc.counts?.trusted_pairs !== doc.pairs.length || doc.counts?.scored_reports !== scoredReports || doc.counts?.structural_mismatches !== structuralMismatches || doc.counts?.scored_pages !== scoredPages) errors.push("baseline.counts do not match pair records");
  return errors;
}

export function loadPdfCalibrationBaseline(jsonText, manifest, manifestSha256) {
  const doc = JSON.parse(jsonText);
  const errors = validatePdfCalibrationBaseline(doc, manifest, manifestSha256);
  if (errors.length) throw new Error(`PDF calibration baseline invalid:\n- ${errors.join("\n- ")}`);
  return doc;
}
