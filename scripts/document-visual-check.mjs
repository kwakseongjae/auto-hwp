#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALUE_OPTIONS = new Set([
  "--reference", "--reference-tier", "--reference-product", "--reference-build",
  "--reference-os", "--font-fingerprint", "--candidate-font-fingerprint", "--reference-note",
  "--output-dir", "--cli", "--python", "--max-translation-px",
]);

export function usage() {
  return `Usage:
  node scripts/document-visual-check.mjs DOCUMENT.hwp[x] \\
    --reference REFERENCE.pdf --reference-tier T0|T1|T2|T3 \\
    --output-dir NEW_DIR [provenance options] [--cli target/debug/auto-hwp]

The command exports DOCUMENT through auto-hwp's own PDF path, emits content-free semantic regions
from the same placement, and runs the report-only PDF comparator. It never defines a pass threshold.`;
}

export function parseArgs(argv) {
  const args = { cli: join(repo, "target/debug/auto-hwp"), python: "python3" };
  let document = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) {
      if (!VALUE_OPTIONS.has(arg)) throw new Error(`unknown option: ${arg}`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      args[arg.slice(2).replaceAll("-", "_")] = value;
    } else if (document === null) document = arg;
    else throw new Error(`unexpected positional argument: ${arg}`);
  }
  if (args.help) return { ...args, document };
  for (const required of ["reference", "reference_tier", "output_dir"]) {
    if (!args[required]) throw new Error(`--${required.replaceAll("_", "-")} is required`);
  }
  if (!document) throw new Error("DOCUMENT.hwp[x] is required");
  if (!new Set(["T0", "T1", "T2", "T3"]).has(args.reference_tier)) {
    throw new Error("--reference-tier must be T0, T1, T2, or T3");
  }
  if (args.max_translation_px !== undefined && !/^[0-3]$/.test(args.max_translation_px)) {
    throw new Error("--max-translation-px must be 0..3");
  }
  return { ...args, document };
}

function regularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function command(executable, args, label, timeout = 300_000) {
  const result = spawnSync(executable, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout,
    shell: false,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.code ?? result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit status ${result.status}; no private subprocess output was copied`);
}

function privateFile(path) {
  regularFile(path, "generated artifact");
  chmodSync(path, 0o600);
}

export function runVisualCheck(args) {
  const document = resolve(args.document);
  const reference = resolve(args.reference);
  const cli = resolve(args.cli);
  const outputDir = resolve(args.output_dir);
  if (![".hwp", ".hwpx"].includes(extname(document).toLowerCase())) throw new Error("DOCUMENT must end in .hwp or .hwpx");
  if (extname(reference).toLowerCase() !== ".pdf") throw new Error("--reference must end in .pdf");
  regularFile(document, "document");
  regularFile(reference, "reference");
  regularFile(cli, "auto-hwp CLI");
  if (existsSync(outputDir)) throw new Error("output directory already exists; refusing to overwrite");
  const outputParent = dirname(outputDir);
  mkdirSync(outputParent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(outputParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("output parent must be a real directory");
  const stage = join(outputParent, `.auto-hwp-visual-${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(stage, { mode: 0o700 });
  const candidate = join(stage, "candidate-own.pdf");
  const regions = join(stage, "candidate-regions.json");
  const report = join(stage, "report");
  try {
    command(cli, ["export-pdf", document, "-o", candidate, "--visual-regions", regions], "own PDF export");
    privateFile(candidate);
    privateFile(regions);
    const compareArgs = [
      join(repo, "scripts/pdf-visual-check.py"), candidate,
      "--reference", reference,
      "--candidate-regions", regions,
      "--reference-tier", args.reference_tier,
      "--output-dir", report,
    ];
    for (const [key, flag] of [
      ["reference_product", "--reference-product"],
      ["reference_build", "--reference-build"],
      ["reference_os", "--reference-os"],
      ["font_fingerprint", "--font-fingerprint"],
      ["candidate_font_fingerprint", "--candidate-font-fingerprint"],
      ["reference_note", "--reference-note"],
      ["max_translation_px", "--max-translation-px"],
    ]) if (args[key] !== undefined) compareArgs.push(flag, args[key]);
    command(args.python, compareArgs, "PDF visual comparator");
    const evidence = JSON.parse(readFileSync(regions, "utf8"));
    const reportJson = JSON.parse(readFileSync(join(report, "report.json"), "utf8"));
    const summary = {
      schema_version: 1,
      mode: "report-only",
      source_format: extname(document).slice(1).toLowerCase(),
      candidate_pdf_sha256: evidence.candidate_pdf_sha256,
      visual_region_schema_version: evidence.schema_version,
      report_status: reportJson.status,
      policy_pass: null,
      artifacts: {
        candidate_pdf: "candidate-own.pdf",
        candidate_regions: "candidate-regions.json",
        report_json: "report/report.json",
        report_html: "report/index.html",
      },
    };
    writeFileSync(join(stage, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(
      join(stage, "index.html"),
      "<!doctype html><meta charset=\"utf-8\"><title>auto-hwp visual check</title>" +
        "<h1>auto-hwp visual check - report only</h1><p>No pass/fail threshold is defined.</p>" +
        "<p><a href=\"report/index.html\">Open the visual report</a></p>",
      { mode: 0o600, flag: "wx" },
    );
    chmodSync(stage, 0o700);
    if (existsSync(outputDir)) throw new Error("output directory appeared during generation; refusing to replace it");
    renameSync(stage, outputDir);
    chmodSync(outputDir, 0o700);
    return summary;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log(usage());
    else {
      const result = runVisualCheck(args);
      console.log(`document visual check: ${result.report_status} (report-only; pass=null)`);
      console.log(`html: ${resolve(args.output_dir, "index.html")}`);
    }
  } catch (error) {
    console.error(`document-visual-check: ${error.message}`);
    process.exitCode = 1;
  }
}
