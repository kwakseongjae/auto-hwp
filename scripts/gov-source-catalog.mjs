#!/usr/bin/env node
// Validate and render the inert, metadata-only public source catalog (issue #99).
// This command deliberately performs no network I/O and never downloads binaries.
//
// Usage:
//   node scripts/gov-source-catalog.mjs --check
//   node scripts/gov-source-catalog.mjs --write

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generatedMarkdownErrors,
  renderCatalogMarkdown,
  summarizeCatalog,
  validateCatalog,
  validateTypesetCoverage,
} from "./lib/gov-source-catalog.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(repo, "corpus", "gov-source-catalog.json");
const coveragePath = join(repo, "corpus", "typeset-coverage.json");
const markdownPath = join(repo, "corpus", "GOV-SOURCE-CATALOG.md");

function usage() {
  console.log("usage: node scripts/gov-source-catalog.mjs --check|--write");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}
if (args.length !== 1 || !["--check", "--write"].includes(args[0])) {
  usage();
  process.exit(2);
}

for (const path of [catalogPath, coveragePath]) {
  if (!existsSync(path)) {
    console.error(`gov-source-catalog: missing ${relative(repo, path)}`);
    process.exit(1);
  }
}

let catalog;
let coverage;
try {
  catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
} catch (error) {
  console.error(`gov-source-catalog: invalid JSON: ${error.message}`);
  process.exit(1);
}

const validationErrors = [...validateCatalog(catalog), ...validateTypesetCoverage(coverage)];
if (validationErrors.length) {
  for (const error of validationErrors) console.error(`gov-source-catalog: ${error}`);
  process.exit(1);
}

const summary = summarizeCatalog(catalog, coverage);
const rendered = renderCatalogMarkdown(catalog, summary);

if (args[0] === "--write") {
  writeFileSync(markdownPath, rendered, "utf8");
  console.log(
    `gov-source-catalog --write: ${summary.candidates} candidates / ${summary.used_source_families} source families -> ${relative(repo, markdownPath)}`,
  );
  process.exit(0);
}

if (!existsSync(markdownPath)) {
  console.error(`gov-source-catalog: missing ${relative(repo, markdownPath)}`);
  process.exit(1);
}
const errors = generatedMarkdownErrors(
  catalog,
  coverage,
  readFileSync(markdownPath, "utf8"),
);
if (errors.length) {
  for (const error of errors) console.error(`gov-source-catalog --check: ${error}`);
  console.error("gov-source-catalog --check: run with --write to regenerate the Markdown summary");
  process.exit(1);
}

console.log(
  `gov-source-catalog --check: ok (${summary.candidates} candidates, ${summary.used_source_families} source families, ${summary.pair_summary.groups} pairs)`,
);
