#!/usr/bin/env node
// corpus/gov-sources.json 재현 스크립트 — KOGL 실측 검증된 공공문서를 **원 출처에서 직접**
// 내려받아 sha256 검증 후 corpus/private/bench-public/files/ 에 둔다(바이너리는 레포에 커밋하지
// 않는다 — 재배포 대신 재현: korea.kr 자유이용이 "텍스트 한정"이라 첨부 내 제3자 이미지 리스크 회피).
// 사용: node scripts/fetch-gov-corpus.mjs
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGovSources } from "./lib/gov-sources.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repo, "corpus", "private", "bench-public", "files");
const manifestPath = join(repo, "corpus", "gov-sources.json");

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function namedPathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function hasDocumentMagic(bytes) {
  return (
    (bytes[0] === 0x50 && bytes[1] === 0x4b) ||
    (bytes[0] === 0xd0 && bytes[1] === 0xcf)
  );
}

function openReadOnlyNoFollow(path) {
  try {
    return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (process.platform !== "win32" || !["EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
    return openSync(path, constants.O_RDONLY);
  }
}

/** Read and validate one fixed, privately owned inode without following a named symlink. */
export function admitExistingDocument(
  path,
  item,
  { maxBytes = MAX_DOCUMENT_BYTES, beforeOpen, beforeFinalStat } = {},
) {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`${path}: regular non-symlink file with one link required`);
  }
  if (before.size < 1 || before.size > maxBytes) {
    throw new Error(`${path}: file size ${before.size} exceeds policy`);
  }

  beforeOpen?.(path);
  const fd = openReadOnlyNoFollow(path);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, before)) {
      throw new Error(`${path}: file identity changed during admission`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${path}: file was truncated during admission`);
      offset += count;
    }
    beforeFinalStat?.();
    const finished = fstatSync(fd);
    const named = lstatSync(path);
    if (
      !sameIdentity(finished, opened) ||
      !sameIdentity(named, opened) ||
      finished.size !== opened.size ||
      finished.nlink !== 1 ||
      named.nlink !== 1
    ) {
      throw new Error(`${path}: file identity/link/size changed during admission`);
    }
    if (!hasDocumentMagic(bytes)) throw new Error(`${path}: document magic mismatch`);
    const have = sha256(bytes);
    const want = String(item.sha256).toLowerCase();
    if (have !== want) throw new Error(`${path}: sha256 ${have} ≠ ${want}`);
    return { bytes, sha256: have };
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish to a newly created inode only. Failures deliberately leave the owned inode in place instead
 * of unlinking a name that another process could have replaced during error handling.
 */
export function publishBytesNoReplace(
  bytes,
  destination,
  { mode = 0o600, beforeOpen, afterWrite } = {},
) {
  mkdirSync(dirname(destination), { recursive: true });
  beforeOpen?.(destination);
  const fd = openSync(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o000,
  );
  try {
    const opened = fstatSync(fd);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${destination}: zero-byte write`);
      offset += count;
    }
    fsyncSync(fd);
    afterWrite?.(destination);
    const finished = fstatSync(fd);
    const named = lstatSync(destination);
    if (
      !opened.isFile() ||
      !sameIdentity(finished, opened) ||
      !sameIdentity(named, opened) ||
      finished.size !== bytes.length ||
      finished.nlink !== 1 ||
      named.nlink !== 1
    ) {
      throw new Error(`${destination}: published file identity/link/size changed`);
    }
    fchmodSync(fd, mode);
    fsyncSync(fd);
    return destination;
  } finally {
    closeSync(fd);
  }
}

export async function fetchGovCorpus({
  manifest = manifestPath,
  output = outDir,
  fetchImpl = globalThis.fetch,
  logger = console,
  maxBytes = MAX_DOCUMENT_BYTES,
} = {}) {
  const items = loadGovSources(readFileSync(manifest, "utf8"));
  if (items.length === 0) {
    throw new Error("fetch-gov-corpus: gov-sources.json 에 검증된 항목이 없다");
  }

  const outputRoot = resolve(output);
  mkdirSync(outputRoot, { recursive: true });
  const counts = { ok: 0, skip: 0, fail: 0, mismatch: 0 };

  for (const item of items) {
    const dest = resolve(outputRoot, item.file);
    if (dirname(dest) !== outputRoot) {
      throw new Error(`fetch-gov-corpus: destination escaped output root for ${item.file}`);
    }
    const want = String(item.sha256).toLowerCase();
    if (namedPathExists(dest)) {
      try {
        admitExistingDocument(dest, item, { maxBytes });
        counts.skip++;
      } catch (error) {
        logger.log(`✗ ${item.file}: ${error?.message ?? error} — existing file preserved`);
        counts.fail++;
      }
      continue;
    }

    try {
      const res = await fetchImpl(item.source_url, {
        redirect: "follow",
        headers: { "User-Agent": "auto-hwp-gov-corpus-fetch" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1 || buf.length > maxBytes) {
        throw new Error(`download size ${buf.length} exceeds policy`);
      }
      if (!hasDocumentMagic(buf)) throw new Error("매직바이트 불일치(에러 페이지?)");
      const have = sha256(buf);
      if (have !== want) {
        counts.mismatch++;
        throw new Error(`sha256 ${have} ≠ ${want}`);
      }
      publishBytesNoReplace(buf, dest);
      logger.log(
        `✓ ${item.file} (${(buf.length / 1024).toFixed(0)}KB, ${item.kogl}, sha256 ${have.slice(0, 16)}…)`,
      );
      counts.ok++;
    } catch (error) {
      logger.log(
        `✗ ${item.file}: ${error?.message ?? error} — source_page 에서 수동 확인: ${item.source_page ?? ""}`,
      );
      counts.fail++;
    }
  }
  return counts;
}

export function formatFetchSummary({ ok, skip, mismatch, fail }) {
  return `fetch-gov-corpus: ${ok} 받음 · ${skip} 이미 있음(해시일치) · ${mismatch} 해시불일치 · ${fail} 실패`;
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const counts = await fetchGovCorpus();
  console.log(`\n${formatFetchSummary(counts)}`);
  if (counts.fail > 0) process.exitCode = 1;
}
