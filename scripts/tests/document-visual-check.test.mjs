import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { parseArgs, runVisualCheck } from "../document-visual-check.mjs";

function executable(path, source) {
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "auto-hwp-document-visual-"));
  const document = join(root, "private-form.hwpx");
  const reference = join(root, "official.pdf");
  const cli = join(root, "fake-auto-hwp");
  const python = join(root, "fake-python");
  writeFileSync(document, "synthetic document", { mode: 0o600 });
  writeFileSync(reference, "%PDF-reference", { mode: 0o600 });
  executable(cli, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const out = args[args.indexOf("-o") + 1];
    const regions = args[args.indexOf("--visual-regions") + 1];
    fs.writeFileSync(out, "%PDF-own\\n%%EOF\\n");
    fs.writeFileSync(regions, JSON.stringify({
      schema_version: 1, coordinate_space: "HWPUNIT", candidate_pdf_sha256: "${"a".repeat(64)}",
      pages: [{ page: 1, width: 59500, height: 84200, regions: [] }]
    }) + "\\n");
  `);
  executable(python, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const output = args[args.indexOf("--output-dir") + 1];
    fs.mkdirSync(output, { mode: 0o700 });
    fs.writeFileSync(output + "/report.json", JSON.stringify({ status: "scored_report", policy: { pass: null } }));
    fs.writeFileSync(output + "/index.html", "<!doctype html><title>report</title>");
  `);
  return { root, document, reference, cli, python };
}

test("one command stages private PDF, semantic evidence, and report atomically", () => {
  const { root, document, reference, cli, python } = fixture();
  const output = join(root, "result");
  const result = runVisualCheck({
    document,
    reference,
    reference_tier: "T3",
    output_dir: output,
    cli,
    python,
  });
  assert.equal(result.report_status, "scored_report");
  assert.equal(result.policy_pass, null);
  assert.equal(lstatSync(output).mode & 0o777, 0o700);
  for (const relative of ["candidate-own.pdf", "candidate-regions.json", "summary.json", "index.html"]) {
    assert.equal(lstatSync(join(output, relative)).mode & 0o777, 0o600, relative);
  }
  const summaryText = readFileSync(join(output, "summary.json"), "utf8");
  assert.doesNotMatch(summaryText, /private-form|synthetic document|auto-hwp-document-visual-/);
  assert.throws(() => runVisualCheck({
    document, reference, reference_tier: "T3", output_dir: output, cli, python,
  }), /already exists/);
});

test("argument and input boundaries fail closed", () => {
  assert.throws(() => parseArgs(["doc.hwpx"]), /--reference is required/);
  assert.throws(() => parseArgs([
    "doc.hwpx", "--reference", "ref.pdf", "--reference-tier", "truth", "--output-dir", "out",
  ]), /T0, T1, T2, or T3/);
  const { root, document, reference, cli, python } = fixture();
  const link = join(root, "document-link.hwpx");
  symlinkSync(document, link);
  assert.throws(() => runVisualCheck({
    document: link,
    reference,
    reference_tier: "T3",
    output_dir: join(root, "result"),
    cli,
    python,
  }), /non-symlink/);
});

test("a failed subprocess leaves no partial final or staging directory", () => {
  const { root, document, reference, python } = fixture();
  const cli = join(root, "failing-auto-hwp");
  executable(cli, "process.exit(2);");
  const output = join(root, "result");
  assert.throws(() => runVisualCheck({
    document, reference, reference_tier: "T3", output_dir: output, cli, python,
  }), /exit status 2/);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".auto-hwp-visual-")),
    [],
  );
});
