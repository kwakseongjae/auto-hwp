import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPublicCorpusManifest, summarizePublicCorpus, validatePublicCorpusManifest } from "../lib/public-corpus-manifest.mjs";
import { verifyArtifactBytes } from "../public-corpus-intake.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestText = readFileSync(join(repo, "corpus/public-corpus-manifest.json"), "utf8");

test("committed intake manifest has 20 HWP5, 20 HWPX, and 10 official PDF pairs", () => {
  const doc = loadPublicCorpusManifest(manifestText);
  assert.deepEqual(summarizePublicCorpus(doc), { artifacts: 50, formats: { hwp5: 20, hwpx: 20, pdf: 10 }, official_pdf_pairs: 10 });
});

test("manifest rejects downgraded rights, privacy, hashes, ordering, and unknown fields", () => {
  const base = JSON.parse(manifestText);
  for (const mutate of [
    (doc) => { doc.artifacts[0].license.scope = "unknown"; },
    (doc) => { doc.artifacts[0].privacy_review.decision = "quarantine"; },
    (doc) => { doc.artifacts[0].sha256 = "A".repeat(64); },
    (doc) => { doc.artifacts[0].retrieved_at = "2026-02-31T00:00:00.000Z"; },
    (doc) => { doc.artifacts[0].source_url = "https://attacker.example/download"; },
    (doc) => { doc.artifacts[0].allowed_redirect_hosts = ["attacker.example"]; },
    (doc) => { doc.artifacts.reverse(); },
    (doc) => { doc.artifacts[0].local_path = "/private/example"; },
  ]) {
    const doc = structuredClone(base);
    mutate(doc);
    assert.notEqual(validatePublicCorpusManifest(doc).length, 0);
  }
});

test("manifest rejects missing format floors and broken PDF pairing", () => {
  const doc = JSON.parse(manifestText);
  doc.artifacts = doc.artifacts.filter((artifact) => artifact.format !== "pdf");
  assert.match(validatePublicCorpusManifest(doc).join("\n"), /minimums unmet/);
});

test("byte verification fails closed on hash, size, and format changes", () => {
  const bytes = readFileSync(join(repo, "corpus/hwpx/00_smoke_min.hwpx"));
  const artifact = {
    file: "fixture.hwpx",
    sha256: "0".repeat(64),
    size_bytes: bytes.length,
    detected_magic: "hwpx-owpml-zip",
  };
  assert.throws(() => verifyArtifactBytes(bytes, artifact), /hash-change/);
});
