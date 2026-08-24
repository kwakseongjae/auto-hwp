#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureFiles } from "./lib/ai-task-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "evaluations", "ai-native", "v1");
const mode = process.argv.includes("--write") ? "write" : "check";
let failed = false;

for (const [name, expected] of Object.entries(fixtureFiles())) {
  const target = path.join(outputDir, name);
  if (mode === "write") {
    await mkdir(outputDir, { recursive: true });
    await writeFile(target, expected);
    process.stdout.write(`[ai-task-fixture] wrote ${path.relative(root, target)}\n`);
    continue;
  }
  let actual = null;
  try { actual = await readFile(target, "utf8"); } catch { /* reported below */ }
  if (actual !== expected) {
    failed = true;
    process.stderr.write(`[ai-task-fixture] stale or missing ${path.relative(root, target)}; run with --write\n`);
  }
}

if (failed) process.exitCode = 1;
