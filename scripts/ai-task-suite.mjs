#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSuite, loadSuite } from "./lib/ai-task-suite.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { manifest, records } = await loadSuite(root);
const report = evaluateSuite(manifest, records);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`[ai-task-suite] ${report.documents} documents / ${report.tasks} tasks\n`);
  process.stdout.write(`[ai-task-suite] provider ${report.providers.join(", ")}\n`);
  for (const [name, score] of Object.entries(report.dimensions)) {
    const rate = score.rate === null ? "n/a" : `${(score.rate * 100).toFixed(1)}%`;
    process.stdout.write(`[ai-task-suite] ${name}: ${score.passed}/${score.total} (${rate})\n`);
  }
  process.stdout.write(`[ai-task-suite] hard gates: ${report.ok ? "PASS" : `FAIL (${report.gate_failures.join(", ")})`}\n`);
}

if (!report.ok) process.exitCode = 1;
