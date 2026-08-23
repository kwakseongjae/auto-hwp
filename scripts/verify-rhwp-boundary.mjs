#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { verifyRhwpBoundary } from "./lib/rhwp-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let submoduleHead = null;
if (fs.existsSync(path.join(root, "external/rhwp/.git"))) {
  submoduleHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(root, "external/rhwp"), encoding: "utf8" }).trim();
}
const errors = verifyRhwpBoundary(root, { submoduleHead });
if (errors.length) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
console.log("PASS: rhwp fork metadata, gitlink, version, and production boundary are lockstep");
