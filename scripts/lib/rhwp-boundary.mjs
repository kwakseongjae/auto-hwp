import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const POLICY_KEYS = [
  "schema_version", "fork_repo", "upstream_repo", "fork_release_tag", "fork_commit",
  "crate_version", "upstream_base_tag", "upstream_base_commit", "policy_issue",
  "implementation_issue",
];
const SHA40 = /^[0-9a-f]{40}$/;

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function requireMatch(errors, value, re, message) {
  if (!re.test(value)) errors.push(message);
}

function localGitlink(root) {
  const out = execFileSync("git", ["ls-files", "--stage", "--", "external/rhwp"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const match = /^160000 ([0-9a-f]{40}) 0\texternal\/rhwp$/.exec(out);
  return match?.[1] ?? null;
}

export function verifyRhwpBoundary(root, options = {}) {
  const errors = [];
  const get = (relative) => options.fileOverrides?.[relative] ?? read(root, relative);
  let policy = options.policyOverride;
  if (policy === undefined) {
    try {
      policy = JSON.parse(get("docs/rhwp-fork-policy.json"));
    } catch (error) {
      return [`invalid policy JSON: ${error.message}`];
    }
  }
  if (JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify([...POLICY_KEYS].sort())) {
    errors.push("policy keys must match the governed schema exactly");
  }
  if (policy.schema_version !== 1) errors.push("policy schema_version must be 1");
  if (policy.policy_issue !== 87 || policy.implementation_issue !== 151) {
    errors.push("policy issue ownership must remain #87/#151");
  }
  for (const key of ["fork_commit", "upstream_base_commit"]) {
    if (!SHA40.test(policy[key] ?? "")) errors.push(`${key} must be 40 lowercase hex`);
  }
  if (policy.fork_repo !== "https://github.com/kwakseongjae/rhwp.git") {
    errors.push("fork_repo must use the governed auto-hwp fork");
  }
  if (policy.upstream_repo !== "https://github.com/edwardkim/rhwp.git") {
    errors.push("upstream_repo must identify the canonical upstream");
  }
  if (policy.fork_release_tag !== `v${policy.crate_version}`) {
    errors.push("fork release tag and crate version must be lockstep");
  }
  if (policy.upstream_base_tag !== policy.fork_release_tag || policy.upstream_base_commit !== policy.fork_commit) {
    errors.push("unpatched fork must identify the same immutable upstream base");
  }

  const modules = get(".gitmodules");
  requireMatch(errors, modules, /url = https:\/\/github\.com\/kwakseongjae\/rhwp\.git/, ".gitmodules must use the governed fork");
  const gitlink = options.gitlinkCommit ?? localGitlink(root);
  if (gitlink !== policy.fork_commit) errors.push("external/rhwp gitlink must equal policy fork_commit");
  if (options.submoduleHead !== undefined && options.submoduleHead !== null && options.submoduleHead !== policy.fork_commit) {
    errors.push("initialized external/rhwp HEAD must equal policy fork_commit");
  }

  const lock = get("Cargo.lock");
  requireMatch(errors, lock, new RegExp(`name = "rhwp"\\nversion = "${policy.crate_version.replaceAll(".", "\\.")}"`), "Cargo.lock rhwp version must match policy");
  const adapter = get("crates/hwp-rhwp/Cargo.toml");
  requireMatch(errors, adapter, new RegExp(`kwakseongjae/rhwp @ v${policy.crate_version.replaceAll(".", "\\.")}`), "adapter version comment must match policy");
  const vendor = get("scripts/vendor-rhwp.sh");
  for (const marker of ["fork_repo", "fork_release_tag", "fork_commit", "submodule set-url", "checkout --detach"]) {
    if (!vendor.includes(marker)) errors.push(`vendor script missing governed marker: ${marker}`);
  }
  if (/rm\s+-rf|submodule add/.test(vendor)) errors.push("vendor script must not delete or replace the submodule");

  const core = get("crates/hwp-core/src/lib.rs");
  if (/Engine::assemble|fn assemble\s*\(|Box<dyn LayoutEngine>|Box<dyn Renderer>/.test(core)) {
    errors.push("hwp-core must not assemble a dormant rhwp layout/renderer");
  }
  const rhwp = get("crates/hwp-rhwp/src/lib.rs");
  if (/impl LayoutEngine for RhwpEngine|impl Renderer for RhwpEngine|fn is_available\s*\(/.test(rhwp)) {
    errors.push("hwp-rhwp must expose parser/helpers, not production layout/renderer traits");
  }

  const hwpxCargo = get("crates/hwp-hwpx/Cargo.toml");
  const hwpxSources = fs.readdirSync(path.join(root, "crates/hwp-hwpx/src"))
    .filter((name) => name.endsWith(".rs"))
    .map((name) => get(`crates/hwp-hwpx/src/${name}`)).join("\n");
  if (/^rhwp\s*=|hwp-rhwp/m.test(hwpxCargo) || /(?:use|extern crate)\s+(?:hwp_rhwp|rhwp)\b/.test(hwpxSources)) {
    errors.push("hwp-hwpx structural parser/writer must remain rhwp-free");
  }

  const governance = get("docs/RHWP-FORK-GOVERNANCE.md");
  for (const marker of ["HWP5/HWP3", "source:\"original\"", "수식/차트 SVG enrichment", "#107", "#94", "완전 종속되지 않는다"]) {
    if (!governance.includes(marker)) errors.push(`governance missing boundary marker: ${marker}`);
  }
  return errors;
}
