#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { canonicalLayoutGateErrors } from "./lib/canonical-layout-gate.mjs";

const inputPath = process.argv[2];
if (process.argv.length > 3) {
  console.error("usage: node scripts/canonical-layout-gate.mjs [layout-check.json]");
  process.exit(2);
}

let parsed;
try {
  let input;
  if (inputPath) {
    input = await readFile(inputPath, "utf8");
  } else {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = chunks.join("");
  }
  parsed = JSON.parse(input);
} catch (error) {
  console.error(`canonical-layout-gate: invalid JSON input: ${error.message}`);
  process.exit(1);
}

const errors = canonicalLayoutGateErrors(parsed);
if (errors.length > 0) {
  for (const error of errors) console.error(`canonical-layout-gate: ${error}`);
  process.exit(1);
}

console.log("canonical-layout-gate: ok (benchmark=8, benchmark1=18, benchmark2=24; line>=98.9%)");
