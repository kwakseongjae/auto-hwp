#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admitExistingDocument, publishBytesNoReplace } from "./fetch-gov-corpus.mjs";
import { downloadDocument, validateDocumentBytes } from "./lib/safe-document-download.mjs";
import { loadPublicCorpusManifest, summarizePublicCorpus } from "./lib/public-corpus-manifest.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repo, "corpus", "public-corpus-manifest.json");
const outputPath = join(repo, "corpus", "private", "public-intake", "files");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function magicFor(envelope) { return envelope.format === "hwp5" ? "hwp5-cfb" : envelope.format === "hwpx" ? "hwpx-owpml-zip" : "pdf"; }

export function verifyArtifactBytes(bytes, artifact) {
  const envelope = validateDocumentBytes(bytes, artifact.file);
  if (sha256(bytes) !== artifact.sha256) throw new Error("hash-change");
  if (bytes.length !== artifact.size_bytes) throw new Error("size-change");
  if (magicFor(envelope) !== artifact.detected_magic) throw new Error("magic-change");
  return envelope;
}

export async function collectPublicCorpus({
  manifest = manifestPath,
  output = outputPath,
  downloader = downloadDocument,
  logger = console,
} = {}) {
  const doc = loadPublicCorpusManifest(readFileSync(manifest, "utf8"));
  const outputRoot = resolve(output);
  mkdirSync(outputRoot, { recursive: true });
  const counts = { ok: 0, skip: 0, fail: 0 };
  for (const artifact of doc.artifacts) {
    const destination = resolve(outputRoot, artifact.file);
    if (dirname(destination) !== outputRoot) throw new Error("destination-policy");
    try {
      if (existsSync(destination)) {
        const admitted = admitExistingDocument(destination, artifact);
        verifyArtifactBytes(admitted.bytes, artifact);
        counts.skip++;
        logger.log(`ok ${artifact.id} cached`);
        continue;
      }
      const result = await downloader({
        file: artifact.file,
        source_url: artifact.source_url,
        allowed_redirect_hosts: artifact.allowed_redirect_hosts,
      });
      verifyArtifactBytes(result.bytes, artifact);
      publishBytesNoReplace(result.bytes, destination);
      counts.ok++;
      logger.log(`ok ${artifact.id} fetched`);
    } catch {
      counts.fail++;
      logger.log(`fail ${artifact.id} policy-check`);
    }
  }
  return counts;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const doc = loadPublicCorpusManifest(readFileSync(manifestPath, "utf8"));
  if (process.argv.includes("--check")) {
    const summary = summarizePublicCorpus(doc);
    console.log(`public-corpus --check: ok (${summary.formats.hwp5} HWP5, ${summary.formats.hwpx} HWPX, ${summary.official_pdf_pairs} PDF pairs)`);
  } else {
    const counts = await collectPublicCorpus();
    console.log(`public-corpus: ${counts.ok} fetched, ${counts.skip} cached, ${counts.fail} failed`);
    if (counts.fail) process.exitCode = 1;
  }
}
