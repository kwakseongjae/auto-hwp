#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPdfCalibrationBaseline, loadPdfCalibrationManifest, sha256Bytes,
} from "./lib/pdf-calibration-manifest.mjs";
import { loadPublicCorpusManifest } from "./lib/public-corpus-manifest.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = join(repo, "corpus/pdf-calibration-manifest.json");
const defaultPublicManifestPath = join(repo, "corpus/public-corpus-manifest.json");
const defaultBaselinePath = join(repo, "corpus/pdf-calibration-baseline.json");

function usage() {
  return `Usage:
  node scripts/pdf-visual-calibrate.mjs --check
  node scripts/pdf-visual-calibrate.mjs --summarize-reports DIR --output FILE --engine-commit SHA
  node scripts/pdf-visual-calibrate.mjs --run --source-root DIR --reference-root DIR --output-dir DIR --cli FILE [--python FILE]

The run mode exports every HWP5 candidate through auto-hwp's own PDF path, then invokes the
report-only visual oracle. Inputs and full HTML/PNG reports stay in gitignored private directories.`;
}

function parseArgs(argv) {
  const args = { python: "python3", manifest: defaultManifestPath, publicManifest: defaultPublicManifestPath };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (["--check", "--run"].includes(arg)) args[arg.slice(2).replaceAll("-", "_")] = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      args[arg.slice(2).replaceAll("-", "_")] = value;
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

function loadManifests(args) {
  const publicCorpus = loadPublicCorpusManifest(readFileSync(args.publicManifest, "utf8"));
  const manifestBytes = readFileSync(args.manifest);
  return {
    manifest: loadPdfCalibrationManifest(manifestBytes.toString("utf8"), publicCorpus),
    manifestSha256: sha256Bytes(manifestBytes),
  };
}

function regularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}: regular non-symlink file required: ${path}`);
  return stat;
}

function verifyFile(path, expectedSha256, expectedBytes, label) {
  const stat = regularFile(path, label);
  if (expectedBytes !== undefined && stat.size !== expectedBytes) throw new Error(`${label}: byte-size mismatch`);
  const actual = sha256Bytes(readFileSync(path));
  if (actual !== expectedSha256) throw new Error(`${label}: SHA-256 mismatch`);
}

function command(command, args, { cwd = repo, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(0, 8_000);
    throw new Error(`${command} exited ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function normalizedPdffontsFingerprint(path) {
  const { stdout } = command("pdffonts", [path], { timeout: 30_000 });
  const normalized = stdout.split(/\r?\n/u).slice(2).filter((line) => line.trim()).sort().join("\n");
  return `pdffonts-normalized-sha256:${sha256Bytes(Buffer.from(`${normalized}\n`))}`;
}

function reportPairSummary(pair, report) {
  const worst = report.summary.worst_pages[0] ?? null;
  const worstPage = worst ? report.pages.find((page) => page.page === worst.page) : null;
  return {
    pair_id: pair.pair_id,
    status: report.status,
    source_sha256: pair.source.sha256,
    reference_sha256: report.inputs.reference.sha256,
    candidate_sha256: report.inputs.candidate.sha256,
    reference_page_count: report.structural.reference.page_count,
    candidate_page_count: report.structural.candidate.page_count,
    structural_mismatches: report.structural.mismatches,
    scored_pages: report.summary.scored_pages,
    worst_page: worstPage ? {
      page: worstPage.page,
      global_ssim_like: worstPage.metrics.ssim_like.global,
      local_ssim_like_mean: worstPage.metrics.ssim_like.local.mean,
      ink_f1: worstPage.metrics.ink.f1,
      edge_f1: worstPage.metrics.edge.f1,
      worst_tile_recall: worstPage.metrics.worst_tile_recall?.recall ?? null,
    } : null,
    worst_tile: report.summary.worst_tiles[0] ?? null,
  };
}

export function buildCalibrationSummary(manifest, manifestSha256, reports, engineCommit) {
  if (!/^[0-9a-f]{7,40}$/.test(engineCommit)) throw new Error("engine commit must be a 7..40 character lowercase git SHA");
  if (reports.length !== manifest.pairs.length) throw new Error("one report per manifest pair required");
  const first = reports[0]?.report;
  const pairs = reports.map(({ pair, report }) => reportPairSummary(pair, report));
  const counts = {
    trusted_pairs: pairs.length,
    scored_reports: pairs.filter((pair) => pair.status === "scored_report").length,
    structural_mismatches: pairs.filter((pair) => pair.status === "structural_mismatch").length,
    scored_pages: pairs.reduce((sum, pair) => sum + pair.scored_pages, 0),
  };
  return {
    schema_version: 1,
    manifest_sha256: manifestSha256,
    calibration: {
      engine_commit: engineCommit,
      cli_features: ["pdf", "rhwp", "shaper"],
      observed_at: "2026-08-22",
      mode: "report-only",
      quality_threshold: null,
    },
    environment: {
      pdfinfo: first.environment.pdfinfo,
      pdftoppm: first.environment.pdftoppm,
      platform_system: first.environment.platform_system,
      platform_release: first.environment.platform_release,
      platform_machine: first.environment.platform_machine,
      python_implementation: first.environment.python_implementation,
      python_version: first.environment.python_version,
      dpi: first.environment.dpi,
      candidate_font_fingerprint: first.environment.candidate_font_fingerprint,
      alignment: {
        max_abs_translation_px: first.alignment_policy.max_abs_translation_px,
        scale: first.alignment_policy.scale,
        crop: first.alignment_policy.crop,
        rotation_degrees: first.alignment_policy.rotation_degrees,
      },
    },
    counts,
    pairs,
  };
}

function loadReports(manifest, reportsRoot) {
  return manifest.pairs.map((pair) => {
    const report = JSON.parse(readFileSync(join(reportsRoot, pair.pair_id, "report.json"), "utf8"));
    if (report.policy?.mode !== "report-only" || report.policy?.pass !== null) throw new Error(`${pair.pair_id}: report-only contract violated`);
    if (report.inputs?.reference?.tier !== pair.reference.tier) throw new Error(`${pair.pair_id}: reference tier mismatch`);
    if (report.inputs?.reference?.sha256 !== pair.reference.sha256) throw new Error(`${pair.pair_id}: reference hash mismatch`);
    if (report.inputs?.reference?.font_fingerprint !== pair.reference.font_fingerprint) throw new Error(`${pair.pair_id}: reference font fingerprint mismatch`);
    return { pair, report };
  });
}

function summaryHtml(summary) {
  const rows = summary.pairs.map((pair) => {
    const worst = pair.worst_page;
    const metrics = worst ? `ink F1 ${worst.ink_f1 ?? "—"}; edge/local details in report` : "pixel comparison blocked";
    return `<tr><td><a href="reports/${pair.pair_id}/index.html">${pair.pair_id}</a></td><td>${pair.status}</td><td>${pair.reference_page_count}</td><td>${pair.candidate_page_count}</td><td>${metrics}</td></tr>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>auto-hwp PDF calibration</title><style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:.45rem;text-align:left}code{font-size:12px}</style><h1>PDF visual calibration — report only</h1><p>No pass/fail threshold is defined. Structural mismatches never receive pixel scores.</p><p><code>${summary.calibration.engine_commit}</code> · ${summary.counts.trusted_pairs} T0/T1 pairs · ${summary.counts.scored_reports} scored · ${summary.counts.structural_mismatches} structural mismatches</p><table><thead><tr><th>pair</th><th>status</th><th>reference pages</th><th>candidate pages</th><th>diagnostic</th></tr></thead><tbody>${rows}</tbody></table></html>\n`;
}

function summarizeExisting(args, manifest, manifestSha256) {
  if (!args.output || !args.engine_commit) throw new Error("--summarize-reports requires --output and --engine-commit");
  if (existsSync(args.output)) throw new Error(`refusing to overwrite ${args.output}`);
  const summary = buildCalibrationSummary(manifest, manifestSha256, loadReports(manifest, resolve(args.summarize_reports)), args.engine_commit);
  writeFileSync(args.output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(`wrote ${args.output}: ${summary.counts.trusted_pairs} trusted pairs, ${summary.counts.structural_mismatches} structural mismatches`);
}

function runCalibration(args, manifest, manifestSha256) {
  for (const required of ["source_root", "reference_root", "output_dir", "cli"]) if (!args[required]) throw new Error(`--run requires --${required.replaceAll("_", "-")}`);
  const sourceRoot = resolve(args.source_root);
  const referenceRoot = resolve(args.reference_root);
  const outputDir = resolve(args.output_dir);
  const cli = resolve(args.cli);
  regularFile(cli, "auto-hwp CLI");
  verifyFile(join(repo, manifest.policy.candidate_font.file), manifest.policy.candidate_font.sha256, undefined, "candidate font");
  if (existsSync(outputDir)) throw new Error(`refusing to overwrite output directory: ${outputDir}`);
  mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
  const stage = `${outputDir}.stage-${process.pid}-${randomBytes(5).toString("hex")}`;
  mkdirSync(stage, { mode: 0o700 });
  mkdirSync(join(stage, "candidates"), { mode: 0o700 });
  mkdirSync(join(stage, "reports"), { mode: 0o700 });
  try {
    for (const [index, pair] of manifest.pairs.entries()) {
      const source = join(sourceRoot, pair.source.file);
      const reference = join(referenceRoot, pair.reference.file);
      verifyFile(source, pair.source.sha256, undefined, `${pair.pair_id} source`);
      verifyFile(reference, pair.reference.sha256, pair.reference.size_bytes, `${pair.pair_id} reference`);
      const fingerprint = normalizedPdffontsFingerprint(reference);
      if (fingerprint !== pair.reference.font_fingerprint) throw new Error(`${pair.pair_id}: pdffonts fingerprint mismatch`);
      const candidate = join(stage, "candidates", `${pair.pair_id}-own.pdf`);
      command(cli, ["export-pdf", source, "-o", candidate], { timeout: 180_000 });
      command(args.python, [
        join(repo, "scripts/pdf-visual-check.py"), candidate,
        "--reference", reference,
        "--reference-tier", pair.reference.tier,
        "--reference-product", pair.reference.product,
        "--reference-build", pair.reference.build,
        "--reference-os", pair.reference.os,
        "--font-fingerprint", pair.reference.font_fingerprint,
        "--candidate-font-fingerprint", `sha256:${manifest.policy.candidate_font.sha256}`,
        "--reference-note", pair.reference.note,
        "--max-translation-px", String(manifest.policy.raster.max_translation_px),
        "--output-dir", join(stage, "reports", pair.pair_id),
      ], { timeout: 180_000 });
      console.log(`[${index + 1}/${manifest.pairs.length}] ${pair.pair_id}`);
    }
    const reports = loadReports(manifest, join(stage, "reports"));
    const engineCommit = command("git", ["rev-parse", "HEAD"]).stdout.trim();
    const summary = buildCalibrationSummary(manifest, manifestSha256, reports, engineCommit);
    writeFileSync(join(stage, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(stage, "index.html"), summaryHtml(summary), { mode: 0o600 });
    chmodSync(stage, 0o700);
    renameSync(stage, outputDir);
    console.log(`report-only calibration: ${summary.counts.scored_reports} scored, ${summary.counts.structural_mismatches} structural mismatches`);
    console.log(`HTML: ${join(outputDir, "index.html")}`);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const { manifest, manifestSha256 } = loadManifests(args);
    if (args.check) {
      const baseline = loadPdfCalibrationBaseline(readFileSync(defaultBaselinePath, "utf8"), manifest, manifestSha256);
      console.log(`PDF calibration baseline OK: ${manifest.pairs.length} T0/T1 pairs; ${baseline.counts.scored_reports} scored; ${baseline.counts.structural_mismatches} structural mismatches; report-only; threshold=null`);
    } else if (args.summarize_reports) {
      summarizeExisting(args, manifest, manifestSha256);
    } else if (args.run) {
      runCalibration(args, manifest, manifestSha256);
    } else {
      throw new Error(usage());
    }
  } catch (error) {
    console.error(`pdf-visual-calibrate: ${error.message}`);
    process.exit(1);
  }
}
