import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDesktopReleaseManifest,
  validateReleaseIdentity,
  verifyDesktopReleaseManifest,
} from "../lib/desktop-release-manifest.mjs";

const SHA = "a".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-hwp-release-contract-"));
  await writeFile(join(root, "auto-hwp_1.2.3_universal.dmg"), "mac installer");
  await writeFile(join(root, "auto-hwp_1.2.3_x64-setup.exe"), "windows installer");
  return root;
}

function spec(overrides = {}) {
  return {
    source_sha: SHA,
    main_sha: SHA,
    version: "1.2.3",
    channel: "stable",
    targets: [
      {
        id: "macos-universal",
        platform: "macos",
        architecture: "universal",
        artifacts: ["auto-hwp_1.2.3_universal.dmg"],
      },
      {
        id: "windows-x86_64",
        platform: "windows",
        architecture: "x86_64",
        artifacts: ["auto-hwp_1.2.3_x64-setup.exe"],
      },
    ],
    ...overrides,
  };
}

test("stable and preview identities are exact-main and channel/version bound", () => {
  assert.deepEqual(validateReleaseIdentity({ sourceSha: SHA, mainSha: SHA, version: "1.2.3", channel: "stable" }), {
    source_sha: SHA,
    version: "1.2.3",
    channel: "stable",
  });
  assert.equal(
    validateReleaseIdentity({ sourceSha: SHA, mainSha: SHA, version: "1.2.4-rc.1", channel: "preview" }).channel,
    "preview",
  );
});

test("identity rejects malformed/mismatched SHA, version, and channel", () => {
  assert.throws(() => validateReleaseIdentity({ sourceSha: "A".repeat(40), mainSha: SHA, version: "1.2.3", channel: "stable" }), /lowercase 40-hex/);
  assert.throws(() => validateReleaseIdentity({ sourceSha: SHA, mainSha: "b".repeat(40), version: "1.2.3", channel: "stable" }), /does not equal/);
  assert.throws(() => validateReleaseIdentity({ sourceSha: SHA, mainSha: SHA, version: "1.2", channel: "stable" }), /SemVer/);
  assert.throws(() => validateReleaseIdentity({ sourceSha: SHA, mainSha: SHA, version: "1.2.3-rc.1", channel: "stable" }), /cannot use/);
  assert.throws(() => validateReleaseIdentity({ sourceSha: SHA, mainSha: SHA, version: "1.2.3", channel: "preview" }), /requires a prerelease/);
  assert.throws(() => validateReleaseIdentity({ sourceSha: SHA, mainSha: SHA, version: "1.2.3", channel: "nightly" }), /preview or stable/);
});

test("manifest is deterministic, complete, and verifies artifact bytes", async () => {
  const root = await fixture();
  const manifest = await buildDesktopReleaseManifest(spec(), root);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.targets.length, 2);
  assert.deepEqual(manifest.targets.map(({ id }) => id), ["macos-universal", "windows-x86_64"]);
  for (const target of manifest.targets) {
    for (const artifact of target.artifacts) {
      assert.ok(artifact.bytes > 0);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    }
  }
  assert.equal(await verifyDesktopReleaseManifest(manifest, root, SHA), true);
  await writeFile(join(root, "auto-hwp_1.2.3_universal.dmg"), "tampered");
  await assert.rejects(verifyDesktopReleaseManifest(manifest, root, SHA), /byte length mismatch|checksum mismatch/);
});

test("a complete preview manifest uses the same bounded target contract", async () => {
  const root = await fixture();
  const manifest = await buildDesktopReleaseManifest(spec({ version: "1.2.4-rc.1", channel: "preview" }), root);
  assert.equal(manifest.version, "1.2.4-rc.1");
  assert.equal(manifest.channel, "preview");
  assert.equal(await verifyDesktopReleaseManifest(manifest, root, SHA), true);
});

test("manifest rejects unknown, missing, duplicate, and mismatched targets", async () => {
  const root = await fixture();
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [spec().targets[0]] }), root), /required target windows-x86_64 is missing/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [...spec().targets, spec().targets[0]] }), root), /duplicated/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], id: "linux-x86_64" }, spec().targets[1]] }), root), /unsupported/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], architecture: "aarch64" }, spec().targets[1]] }), root), /architecture mismatch/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], platform: "windows" }, spec().targets[1]] }), root), /platform mismatch/);
});

test("manifest rejects missing, duplicate, unsafe, wrong-target, empty, and symlink artifacts", async () => {
  const root = await fixture();
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], artifacts: [] }, spec().targets[1]] }), root), /has no artifacts/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], artifacts: ["../escape.dmg"] }, spec().targets[1]] }), root), /safe basename/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], artifacts: ["auto-hwp_1.2.3_x64-setup.exe"] }, spec().targets[1]] }), root), /does not match target/);
  await writeFile(join(root, "empty.dmg"), "");
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], artifacts: ["empty.dmg"] }, spec().targets[1]] }), root), /is empty/);
  await symlink(join(root, "auto-hwp_1.2.3_universal.dmg"), join(root, "linked.dmg"));
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], artifacts: ["linked.dmg"] }, spec().targets[1]] }), root), /non-symlink/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], artifacts: ["auto-hwp_1.2.3_universal.dmg", "auto-hwp_1.2.3_universal.dmg"] }, spec().targets[1]] }), root), /duplicated/);
  await assert.rejects(buildDesktopReleaseManifest(spec({ targets: [{ ...spec().targets[0], artifacts: ["auto-hwp_1.2.3_universal.dmg"] }, { ...spec().targets[1], artifacts: ["auto-hwp_1.2.3_universal.dmg"] }] }), root), /does not match target|duplicated/);
});

test("strict schema rejects unknown fields in specs and committed manifests", async () => {
  const root = await fixture();
  await assert.rejects(buildDesktopReleaseManifest({ ...spec(), secret: "must-not-pass" }, root), /spec.secret is unknown/);
  const manifest = await buildDesktopReleaseManifest(spec(), root);
  await assert.rejects(verifyDesktopReleaseManifest({ ...manifest, endpoint: "surprise" }, root, SHA), /manifest.endpoint is unknown/);
  await assert.rejects(verifyDesktopReleaseManifest(manifest, root, "b".repeat(40)), /does not equal/);
});

test("manual preflight is read-only, exact-main, pinned, and cannot touch release credentials", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/desktop-release-preflight.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+push:|\n\s+pull_request:/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|packages: write|attestations: write/);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /git fetch --no-tags --depth=1 origin main/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /git rev-parse origin\/main/);
  assert.match(workflow, /desktop-release-manifest\.mjs preflight/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|upload-artifact|create-release|tauri-action/);
});
