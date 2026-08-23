import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyRhwpBoundary } from "../lib/rhwp-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "docs/rhwp-fork-policy.json"), "utf8"));

test("repository rhwp boundary is internally consistent", () => {
  assert.deepEqual(verifyRhwpBoundary(root, { gitlinkCommit: policy.fork_commit, submoduleHead: policy.fork_commit }), []);
});

test("verifier rejects a gitlink or initialized checkout drift", () => {
  const other = "0".repeat(40);
  assert.match(verifyRhwpBoundary(root, { gitlinkCommit: other }).join("\n"), /gitlink/);
  assert.match(verifyRhwpBoundary(root, { gitlinkCommit: policy.fork_commit, submoduleHead: other }).join("\n"), /HEAD/);
});

test("verifier itself is network-free and vendor setup is non-destructive", () => {
  const verifier = fs.readFileSync(path.join(root, "scripts/verify-rhwp-boundary.mjs"), "utf8")
    + fs.readFileSync(path.join(root, "scripts/lib/rhwp-boundary.mjs"), "utf8");
  assert.doesNotMatch(verifier, /\b(?:fetch|curl|wget|gh api)\b/);
  const vendor = fs.readFileSync(path.join(root, "scripts/vendor-rhwp.sh"), "utf8");
  assert.doesNotMatch(vendor, /rm\s+-rf|submodule add/);
});

test("strict policy rejects unknown fields", () => {
  const mutated = { ...policy, surprise: true };
  assert.match(verifyRhwpBoundary(root, {
    gitlinkCommit: policy.fork_commit,
    policyOverride: mutated,
  }).join("\n"), /keys/);
});

test("metadata URL, version, tag, and commit drift fail closed", () => {
  const cases = [
    { ...policy, fork_repo: "https://github.com/attacker/rhwp.git" },
    { ...policy, crate_version: "0.7.18" },
    { ...policy, fork_release_tag: "v0.7.18" },
    { ...policy, fork_commit: "0".repeat(40) },
  ];
  for (const changed of cases) {
    assert.notEqual(verifyRhwpBoundary(root, {
      gitlinkCommit: policy.fork_commit,
      policyOverride: changed,
    }).length, 0);
  }
});

test("production facade and HWPX ownership drift fail closed", () => {
  const corePath = "crates/hwp-core/src/lib.rs";
  const hwpxPath = "crates/hwp-hwpx/Cargo.toml";
  const governancePath = "docs/RHWP-FORK-GOVERNANCE.md";
  const core = fs.readFileSync(path.join(root, corePath), "utf8");
  const hwpx = fs.readFileSync(path.join(root, hwpxPath), "utf8");
  const governance = fs.readFileSync(path.join(root, governancePath), "utf8");
  assert.match(verifyRhwpBoundary(root, {
    gitlinkCommit: policy.fork_commit,
    fileOverrides: { [corePath]: `${core}\nfn assemble() {}` },
  }).join("\n"), /assemble/);
  assert.match(verifyRhwpBoundary(root, {
    gitlinkCommit: policy.fork_commit,
    fileOverrides: { [hwpxPath]: `${hwpx}\nrhwp = "0.7"` },
  }).join("\n"), /rhwp-free/);
  assert.match(verifyRhwpBoundary(root, {
    gitlinkCommit: policy.fork_commit,
    fileOverrides: { [governancePath]: governance.replace("완전 종속되지 않는다", "") },
  }).join("\n"), /governance/);
});
