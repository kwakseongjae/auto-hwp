import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadPdfCalibrationBaseline, loadPdfCalibrationManifest, sha256Bytes,
  validatePdfCalibrationBaseline, validatePdfCalibrationManifest,
} from "../lib/pdf-calibration-manifest.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const publicCorpus = JSON.parse(readFileSync(join(repo, "corpus/public-corpus-manifest.json"), "utf8"));
const manifestBytes = readFileSync(join(repo, "corpus/pdf-calibration-manifest.json"));
const manifestSha256 = sha256Bytes(manifestBytes);
const manifest = loadPdfCalibrationManifest(manifestBytes.toString("utf8"), publicCorpus);
const baselineText = readFileSync(join(repo, "corpus/pdf-calibration-baseline.json"), "utf8");

test("committed PDF calibration has 20 explicit T1 pairs and remains report-only", () => {
  assert.equal(manifest.pairs.length, 20);
  assert.ok(manifest.pairs.every((pair) => pair.reference.tier === "T1"));
  assert.equal(manifest.policy.quality_threshold, null);
  assert.deepEqual(manifest.policy.raster, {
    dpi: 144,
    max_translation_px: 3,
    scale: 1,
    crop: false,
    rotation_degrees: 0,
  });
});

test("committed baseline records 18 pixel reports and blocks 2 structural mismatches", () => {
  const baseline = loadPdfCalibrationBaseline(baselineText, manifest, manifestSha256);
  assert.deepEqual(baseline.counts, {
    trusted_pairs: 20,
    scored_reports: 18,
    structural_mismatches: 2,
    scored_pages: 19,
  });
  for (const pair of baseline.pairs) {
    if (pair.status === "structural_mismatch") {
      assert.equal(pair.scored_pages, 0);
      assert.equal(pair.worst_page, null);
      assert.equal(pair.worst_tile, null);
    } else {
      assert.deepEqual(Object.keys(pair.worst_page).sort(), [
        "edge_f1", "global_ssim_like", "ink_f1", "local_ssim_like_mean", "page", "worst_tile_recall",
      ]);
    }
  }
});

test("calibration manifest rejects authority, normalization, path, hash, and schema downgrades", () => {
  const mutations = [
    (doc) => { doc.policy.quality_threshold = 0.8; },
    (doc) => { doc.policy.raster.scale = 0.95; },
    (doc) => { doc.pairs[0].reference.tier = "T3"; },
    (doc) => { doc.pairs[0].reference.file = "../private.pdf"; },
    (doc) => { doc.pairs[0].reference.font_fingerprint = "unknown"; },
    (doc) => { doc.pairs[0].source.sha256 = "A".repeat(64); },
    (doc) => { doc.pairs[0].private_path = "/tmp/leak"; },
  ];
  for (const mutate of mutations) {
    const doc = structuredClone(manifest);
    mutate(doc);
    assert.notEqual(validatePdfCalibrationManifest(doc, publicCorpus).length, 0);
  }
});

test("calibration baseline rejects thresholds, fabricated scores, count drift, and hash drift", () => {
  const source = JSON.parse(baselineText);
  const structuralIndex = source.pairs.findIndex((pair) => pair.status === "structural_mismatch");
  const mutations = [
    (doc) => { doc.calibration.quality_threshold = 0.5; },
    (doc) => { doc.manifest_sha256 = "0".repeat(64); },
    (doc) => { doc.counts.scored_reports++; },
    (doc) => { doc.pairs[0].candidate_sha256 = "A".repeat(64); },
    (doc) => { doc.pairs[structuralIndex].worst_page = { page: 1 }; },
    (doc) => { doc.pass = true; },
  ];
  for (const mutate of mutations) {
    const doc = structuredClone(source);
    mutate(doc);
    assert.notEqual(validatePdfCalibrationBaseline(doc, manifest, manifestSha256).length, 0);
  }
});
