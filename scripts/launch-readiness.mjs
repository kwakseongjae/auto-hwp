#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLaunch,
  automatedLaunchChecks,
  createFsSource,
  preLiveLaunchChecks,
  renderTextReport,
  summarizeChecks,
} from "./lib/launch-readiness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = new Set(process.argv.slice(2));
const allChecks = auditLaunch(createFsSource(repoRoot));
const checks = args.has("--automated")
  ? automatedLaunchChecks(allChecks)
  : args.has("--pre-live")
    ? preLiveLaunchChecks(allChecks)
    : allChecks;
const summary = summarizeChecks(checks);

if (args.has("--json")) {
  process.stdout.write(`${JSON.stringify({ summary, checks }, null, 2)}\n`);
} else {
  process.stdout.write(`${renderTextReport(checks)}\n`);
}

if (args.has("--strict") && !summary.ready) process.exitCode = 1;
