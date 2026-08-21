#!/usr/bin/env node
// Full-corpus layout-check sweep (issue #72 / T1-R2).
// Joins scores with corpus/typeset-coverage.json tags.
//
// Usage:
//   node scripts/oracle-sweep.mjs                 # run + write JSON/MD baseline
//   node scripts/oracle-sweep.mjs --check         # re-run, fail on score regression
//   node scripts/oracle-sweep.mjs --check-committed  # no layout-check; schema/summary only (CI)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCLAIMER,
  byTag,
  joinScore,
  lowestAxes,
  regressionErrors,
  renderMd,
  summarize,
  validateCommitted,
} from "./lib/oracle-score.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = join(repo, "corpus", "typeset-oracle.json");
const mdOut = join(repo, "corpus", "TYPESET-ORACLE.md");
const coveragePath = join(repo, "corpus", "typeset-coverage.json");
const argv = process.argv.slice(2);
const check = argv.includes("--check");
const checkCommitted = argv.includes("--check-committed");

function ensureCli() {
  const bin = join(repo, "target", "release", "auto-hwp");
  if (existsSync(bin)) return bin;
  console.error("oracle-sweep: building auto-hwp (release, rhwp+shaper)…");
  const r = spawnSync(
    "cargo",
    ["build", "--release", "-p", "auto-hwp-cli", "--features", "rhwp,shaper"],
    { cwd: repo, stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("cargo build auto-hwp-cli failed");
  return bin;
}

function runLayoutJson(bin, paths) {
  const reports = [];
  const batch = 8;
  for (let i = 0; i < paths.length; i += batch) {
    const slice = paths.slice(i, i + batch);
    const r = spawnSync(bin, ["layout-check", "--json", ...slice], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0 && !r.stdout) {
      throw new Error(`layout-check --json failed: ${r.stderr || r.status}`);
    }
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) throw new Error("layout-check --json: expected JSON array");
    reports.push(...parsed);
  }
  return reports;
}

function buildDoc(coverage, reports, presentRels) {
  const byFile = new Map();
  for (const r of reports) {
    const rel = relative(repo, r.file).split("\\").join("/");
    byFile.set(r.file, r);
    byFile.set(rel, r);
  }
  const documents = coverage.documents.map((c) => {
    const abs = join(repo, c.rel);
    const missing = !existsSync(abs);
    const cli = byFile.get(abs) || byFile.get(c.rel);
    return joinScore(c, cli, missing && c.collection === "gov");
  });
  documents.sort((a, b) => a.rel.localeCompare(b.rel));
  const by_tag = byTag(documents);
  const generated = {
    schema_version: 1,
    issue: 72,
    generated_at: new Date().toISOString().slice(0, 10),
    command: "auto-hwp layout-check --json (features rhwp,shaper) + scripts/oracle-sweep.mjs",
    disclaimer: DISCLAIMER,
    note: "Scores lock today's stored-lineseg numbers. They are not Hangul ground truth. Unscorable converted HWPX is not a zero. corpus/private user docs are not listed. GOV binaries stay unreproduced in git.",
    coverage_issue: 71,
    present: presentRels,
    summary: summarize(documents),
    by_tag,
    lowest_axes: lowestAxes(by_tag, 3),
    documents,
  };
  return generated;
}

if (checkCommitted) {
  if (!existsSync(jsonOut) || !existsSync(mdOut)) {
    console.error("oracle-sweep --check-committed: corpus/typeset-oracle.json or TYPESET-ORACLE.md missing");
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(jsonOut, "utf8"));
  const errors = validateCommitted(doc);
  const md = readFileSync(mdOut, "utf8");
  if (!md.includes("참값")) errors.push("TYPESET-ORACLE.md must state scores are not Hangul ground truth");
  if (!md.includes("채점 불가")) errors.push("TYPESET-ORACLE.md must distinguish unscorable from zero");
  const rendered = renderMd(doc);
  const stripDate = (s) => s.replace(/생성 \d{4}-\d{2}-\d{2}/, "생성 DATE");
  if (stripDate(md) !== stripDate(rendered)) {
    errors.push("TYPESET-ORACLE.md drifted from typeset-oracle.json (re-run node scripts/oracle-sweep.mjs)");
  }
  if (errors.length) {
    for (const e of errors) console.error(`oracle-sweep --check-committed: ${e}`);
    process.exit(1);
  }
  console.log(
    `oracle-sweep --check-committed: ok (${doc.documents.length} docs, scorable=${doc.summary.scorable}, unscorable=${doc.summary.unscorable})`,
  );
  process.exit(0);
}

if (!existsSync(coveragePath)) {
  console.error("oracle-sweep: corpus/typeset-coverage.json missing (run node scripts/tag-corpus.mjs)");
  process.exit(1);
}
const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
const present = coverage.documents.filter((d) => existsSync(join(repo, d.rel)));
const bin = ensureCli();
const reports = present.length ? runLayoutJson(bin, present.map((d) => join(repo, d.rel))) : [];
const generated = buildDoc(coverage, reports, present.length);

if (existsSync(jsonOut)) {
  const previous = JSON.parse(readFileSync(jsonOut, "utf8"));
  const prevBy = new Map((previous.documents || []).map((d) => [d.rel, d]));
  generated.documents = generated.documents.map((d) => {
    const prev = prevBy.get(d.rel);
    if (d.verdict === "not-fetched" && prev && prev.score_kind !== "not-fetched") {
      return prev;
    }
    return d;
  });
  generated.summary = summarize(generated.documents);
  generated.by_tag = byTag(generated.documents);
  generated.lowest_axes = lowestAxes(generated.by_tag, 3);
}

if (check) {
  if (!existsSync(jsonOut)) {
    console.error("oracle-sweep --check: corpus/typeset-oracle.json missing — run without --check first");
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(jsonOut, "utf8"));
  const errors = regressionErrors(committed.documents, generated.documents);
  if (committed.documents.length !== generated.documents.length) {
    errors.unshift(
      `document count ${committed.documents.length} → ${generated.documents.length} (coverage drift)`,
    );
  }
  if (errors.length) {
    for (const e of errors) console.error(`oracle-sweep --check: ${e}`);
    process.exit(1);
  }
  console.log(
    `oracle-sweep --check: ok (${generated.documents.length} docs, scorable=${generated.summary.scorable}, unscorable=${generated.summary.unscorable})`,
  );
  process.exit(0);
}

mkdirSync(dirname(jsonOut), { recursive: true });
writeFileSync(jsonOut, `${JSON.stringify(generated, null, 2)}\n`);
writeFileSync(mdOut, renderMd(generated));
console.log(`oracle-sweep: ${generated.documents.length} docs → ${relative(repo, jsonOut)} · ${relative(repo, mdOut)}`);
console.log(
  `scorable=${generated.summary.scorable} unscorable=${generated.summary.unscorable} fail=${generated.summary.fail} not-fetched=${generated.summary.not_fetched} match=${generated.summary.match} line_gap=${generated.summary.line_gap} page_gap=${generated.summary.page_gap}`,
);
console.log(`disclaimer: ${DISCLAIMER}`);
const low = generated.lowest_axes || [];
if (low.length) {
  console.log(
    `lowest axes: ${low.map((r) => `${r.tag} line=${r.mean_line_exact_pct ?? "—"} page=${r.page_match_rate ?? "—"}`).join(" · ")}`,
  );
}
