import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const DESKTOP_RELEASE_SCHEMA_VERSION = 1;

export const SUPPORTED_DESKTOP_TARGETS = Object.freeze({
  "macos-universal": Object.freeze({
    platform: "macos",
    architecture: "universal",
    artifactPattern: /(?:\.dmg|\.app\.tar\.gz|\.app\.tar\.gz\.sig)$/,
  }),
  "windows-x86_64": Object.freeze({
    platform: "windows",
    architecture: "x86_64",
    artifactPattern: /(?:\.msi|\.exe|\.msi\.zip|\.msi\.zip\.sig|\.nsis\.zip|\.nsis\.zip\.sig)$/,
  }),
});

const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SHA_40 = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  throw new Error(`desktop release contract: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertExactKeys(value, keys, label) {
  assertObject(value, label);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label}.${key} is unknown`);
  }
  for (const key of keys) {
    if (!(key in value)) fail(`${label}.${key} is required`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

export function validateReleaseIdentity({ sourceSha, mainSha, version, channel }) {
  requireString(sourceSha, "source_sha");
  requireString(mainSha, "main_sha");
  if (!SHA_40.test(sourceSha)) fail("source_sha must be a lowercase 40-hex commit SHA");
  if (!SHA_40.test(mainSha)) fail("main_sha must be a lowercase 40-hex commit SHA");
  if (sourceSha !== mainSha) fail("source_sha does not equal the protected main SHA");

  requireString(version, "version");
  const versionMatch = SEMVER.exec(version);
  if (!versionMatch) fail("version must be valid SemVer");
  if (channel !== "preview" && channel !== "stable") fail("channel must be preview or stable");
  const prerelease = versionMatch[4];
  if (channel === "stable" && prerelease) fail("stable channel cannot use a prerelease version");
  if (channel === "preview" && !prerelease) fail("preview channel requires a prerelease version");
  return { source_sha: sourceSha, version, channel };
}

function validateArtifactName(name, targetId) {
  requireString(name, `target ${targetId} artifact name`);
  if (name !== basename(name) || !SAFE_ARTIFACT_NAME.test(name)) {
    fail(`artifact ${name} must be a safe basename`);
  }
  const definition = SUPPORTED_DESKTOP_TARGETS[targetId];
  if (!definition.artifactPattern.test(name)) {
    fail(`artifact ${name} does not match target ${targetId}`);
  }
}

async function readBoundedArtifact(artifactRoot, name) {
  const root = await realpath(resolve(artifactRoot));
  const candidate = resolve(root, name);
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`artifact ${name} must be a regular non-symlink file`);
  const canonical = await realpath(candidate);
  const fromRoot = relative(root, canonical);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) fail(`artifact ${name} escapes artifact_root`);
  const bytes = await readFile(canonical);
  if (bytes.length === 0) fail(`artifact ${name} is empty`);
  return {
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateTargetDeclaration(target, index) {
  assertExactKeys(target, ["id", "platform", "architecture", "artifacts"], `targets[${index}]`);
  const id = requireString(target.id, `targets[${index}].id`);
  const definition = SUPPORTED_DESKTOP_TARGETS[id];
  if (!definition) fail(`target ${id} is unsupported`);
  if (target.platform !== definition.platform) fail(`target ${id} platform mismatch`);
  if (target.architecture !== definition.architecture) fail(`target ${id} architecture mismatch`);
  if (!Array.isArray(target.artifacts) || target.artifacts.length === 0) fail(`target ${id} has no artifacts`);
  return { id, definition };
}

export async function buildDesktopReleaseManifest(spec, artifactRoot) {
  assertExactKeys(spec, ["source_sha", "main_sha", "version", "channel", "targets"], "spec");
  const identity = validateReleaseIdentity({
    sourceSha: spec.source_sha,
    mainSha: spec.main_sha,
    version: spec.version,
    channel: spec.channel,
  });
  if (!Array.isArray(spec.targets)) fail("spec.targets must be an array");

  const targetIds = new Set();
  const artifactNames = new Set();
  const targets = [];
  for (const [index, target] of spec.targets.entries()) {
    const { id } = validateTargetDeclaration(target, index);
    if (targetIds.has(id)) fail(`target ${id} is duplicated`);
    targetIds.add(id);
    const artifacts = [];
    for (const name of target.artifacts) {
      validateArtifactName(name, id);
      if (artifactNames.has(name)) fail(`artifact ${name} is duplicated`);
      artifactNames.add(name);
      artifacts.push(await readBoundedArtifact(artifactRoot, name));
    }
    targets.push({
      id,
      platform: target.platform,
      architecture: target.architecture,
      artifacts,
    });
  }
  for (const id of Object.keys(SUPPORTED_DESKTOP_TARGETS)) {
    if (!targetIds.has(id)) fail(`required target ${id} is missing`);
  }
  targets.sort((left, right) => left.id.localeCompare(right.id));
  for (const target of targets) target.artifacts.sort((left, right) => left.name.localeCompare(right.name));
  return {
    schema_version: DESKTOP_RELEASE_SCHEMA_VERSION,
    source_sha: identity.source_sha,
    version: identity.version,
    channel: identity.channel,
    targets,
  };
}

function validateManifestArtifact(artifact, targetId, index) {
  assertExactKeys(artifact, ["name", "bytes", "sha256"], `target ${targetId} artifacts[${index}]`);
  validateArtifactName(artifact.name, targetId);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) fail(`artifact ${artifact.name} bytes are invalid`);
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) fail(`artifact ${artifact.name} sha256 is invalid`);
}

export async function verifyDesktopReleaseManifest(manifest, artifactRoot, expectedMainSha) {
  assertExactKeys(manifest, ["schema_version", "source_sha", "version", "channel", "targets"], "manifest");
  if (manifest.schema_version !== DESKTOP_RELEASE_SCHEMA_VERSION) fail("schema_version is unsupported");
  validateReleaseIdentity({
    sourceSha: manifest.source_sha,
    mainSha: expectedMainSha,
    version: manifest.version,
    channel: manifest.channel,
  });
  if (!Array.isArray(manifest.targets)) fail("manifest.targets must be an array");

  const targetIds = new Set();
  const artifactNames = new Set();
  for (const [targetIndex, target] of manifest.targets.entries()) {
    const { id } = validateTargetDeclaration(target, targetIndex);
    if (targetIds.has(id)) fail(`target ${id} is duplicated`);
    targetIds.add(id);
    for (const [artifactIndex, artifact] of target.artifacts.entries()) {
      validateManifestArtifact(artifact, id, artifactIndex);
      if (artifactNames.has(artifact.name)) fail(`artifact ${artifact.name} is duplicated`);
      artifactNames.add(artifact.name);
      const actual = await readBoundedArtifact(artifactRoot, artifact.name);
      if (actual.bytes !== artifact.bytes) fail(`artifact ${artifact.name} byte length mismatch`);
      if (actual.sha256 !== artifact.sha256) fail(`artifact ${artifact.name} checksum mismatch`);
    }
  }
  for (const id of Object.keys(SUPPORTED_DESKTOP_TARGETS)) {
    if (!targetIds.has(id)) fail(`required target ${id} is missing`);
  }
  return true;
}
