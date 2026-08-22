import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  admitExistingDocument,
  fetchGovCorpus,
  publishBytesNoReplace,
  sha256,
} from "../fetch-gov-corpus.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const validHwpx = readFileSync(join(root, "corpus/hwpx/00_smoke_min.hwpx"));
const quietLogger = { log() {} };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "auto-hwp-fetch-security-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    manifest: join(directory, "gov-sources.json"),
    output: join(directory, "files"),
  };
}

function writeManifest(path, bytes = validHwpx) {
  const item = {
    file: "sample.hwpx",
    publisher: "테스트 기관",
    kind: "빈 양식",
    kogl: "KOGL-1",
    kogl_verified: true,
    source_page: "https://example.test/page",
    source_url: "https://example.test/sample.hwpx",
    sha256: sha256(bytes),
  };
  writeFileSync(path, JSON.stringify({ schema_version: 1, files: [item] }));
  return item;
}

test("exclusive publish creates a private file and never replaces a race winner", (t) => {
  const { directory } = fixture(t);
  const destination = join(directory, "sample.hwpx");
  publishBytesNoReplace(validHwpx, destination);
  assert.deepEqual(readFileSync(destination), validHwpx);
  assert.equal(statSync(destination).mode & 0o077, 0);

  const winner = join(directory, "winner.hwpx");
  assert.throws(
    () =>
      publishBytesNoReplace(validHwpx, winner, {
        beforeOpen(path) {
          writeFileSync(path, Buffer.from("winner"), { flag: "wx" });
        },
      }),
    /EEXIST|file already exists/i,
  );
  assert.equal(readFileSync(winner, "utf8"), "winner");
});

test("post-open replacement is detected and preserved without unlinking", (t) => {
  const { directory } = fixture(t);
  const destination = join(directory, "sample.hwpx");
  assert.throws(
    () =>
      publishBytesNoReplace(validHwpx, destination, {
        afterWrite(path) {
          unlinkSync(path);
          writeFileSync(path, Buffer.from("replacement"), { flag: "wx" });
        },
      }),
    /identity\/link\/size changed/,
  );
  assert.equal(readFileSync(destination, "utf8"), "replacement");
});

test("failed owned publish remains unreadable instead of risking a raced unlink", (t) => {
  const { directory } = fixture(t);
  const destination = join(directory, "partial.hwpx");
  assert.throws(
    () =>
      publishBytesNoReplace(validHwpx, destination, {
        afterWrite() {
          throw new Error("injected post-write failure");
        },
      }),
    /injected post-write failure/,
  );
  assert.equal(statSync(destination).mode & 0o777, 0);
});

test("invalid destination metadata fails before output or network I/O", async (t) => {
  const f = fixture(t);
  const item = writeManifest(f.manifest);
  writeFileSync(
    f.manifest,
    JSON.stringify({ schema_version: 1, files: [{ ...item, file: "../outside.hwpx" }] }),
  );
  let fetchCalls = 0;
  await assert.rejects(
    fetchGovCorpus({
      manifest: f.manifest,
      output: f.output,
      fetchImpl: async () => {
        fetchCalls++;
        return new Response(validHwpx);
      },
      logger: quietLogger,
    }),
    /basename only/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(existsSync(f.output), false);
  assert.equal(existsSync(join(f.directory, "outside.hwpx")), false);
});

test("existing mismatched destination is preserved and suppresses network I/O", async (t) => {
  const f = fixture(t);
  const item = writeManifest(f.manifest);
  const destination = join(f.output, item.file);
  mkdirSync(f.output, { recursive: true });
  writeFileSync(destination, Buffer.from("local edit"));
  let fetchCalls = 0;
  const counts = await fetchGovCorpus({
    manifest: f.manifest,
    output: f.output,
    fetchImpl: async () => {
      fetchCalls++;
      return new Response(validHwpx);
    },
    logger: quietLogger,
  });
  assert.equal(counts.fail, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(readFileSync(destination, "utf8"), "local edit");
});

test("existing-file identity races are detected without mutating the replacement", (t) => {
  const f = fixture(t);
  const item = writeManifest(f.manifest);
  const beforeOpen = join(f.directory, "before-open.hwpx");
  writeFileSync(beforeOpen, validHwpx);
  assert.throws(
    () =>
      admitExistingDocument(beforeOpen, item, {
        beforeOpen(path) {
          unlinkSync(path);
          writeFileSync(path, Buffer.from("replacement before open"), { flag: "wx" });
        },
      }),
    /identity changed during admission/,
  );
  assert.equal(readFileSync(beforeOpen, "utf8"), "replacement before open");

  const beforeFinal = join(f.directory, "before-final.hwpx");
  writeFileSync(beforeFinal, validHwpx);
  assert.throws(
    () =>
      admitExistingDocument(beforeFinal, item, {
        beforeFinalStat() {
          unlinkSync(beforeFinal);
          writeFileSync(beforeFinal, Buffer.from("replacement before final stat"), { flag: "wx" });
        },
      }),
    /identity\/link\/size changed during admission/,
  );
  assert.equal(readFileSync(beforeFinal, "utf8"), "replacement before final stat");
});

test("existing symlink and shared hardlink are rejected without mutating their targets", async (t) => {
  const f = fixture(t);
  const item = writeManifest(f.manifest);
  const target = join(f.directory, "outside.hwpx");
  const destination = join(f.output, item.file);
  mkdirSync(f.output, { recursive: true });
  writeFileSync(target, validHwpx);
  symlinkSync(target, destination);
  const counts = await fetchGovCorpus({
    manifest: f.manifest,
    output: f.output,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    logger: quietLogger,
  });
  assert.equal(counts.fail, 1);
  assert.deepEqual(readFileSync(target), validHwpx);

  unlinkSync(destination);
  linkSync(target, destination);
  assert.throws(() => admitExistingDocument(destination, item), /one link required/);
  assert.deepEqual(readFileSync(target), validHwpx);

  unlinkSync(destination);
  symlinkSync(join(f.directory, "missing.hwpx"), destination);
  let fetchCalls = 0;
  const brokenCounts = await fetchGovCorpus({
    manifest: f.manifest,
    output: f.output,
    fetchImpl: async () => {
      fetchCalls++;
      return new Response(validHwpx);
    },
    logger: quietLogger,
  });
  assert.equal(brokenCounts.fail, 1);
  assert.equal(fetchCalls, 0, "a broken named symlink must stop before network I/O");
});

test("destination created while downloading wins and is never overwritten", async (t) => {
  const f = fixture(t);
  const item = writeManifest(f.manifest);
  const destination = join(f.output, item.file);
  const counts = await fetchGovCorpus({
    manifest: f.manifest,
    output: f.output,
    fetchImpl: async () => {
      writeFileSync(destination, Buffer.from("race winner"), { flag: "wx" });
      return new Response(validHwpx, { status: 200 });
    },
    logger: quietLogger,
  });
  assert.equal(counts.fail, 1);
  assert.equal(counts.ok, 0);
  assert.equal(readFileSync(destination, "utf8"), "race winner");
});

test("valid absent and existing documents complete without overwrite", async (t) => {
  const f = fixture(t);
  const item = writeManifest(f.manifest);
  const first = await fetchGovCorpus({
    manifest: f.manifest,
    output: f.output,
    fetchImpl: async () => new Response(validHwpx, { status: 200 }),
    logger: quietLogger,
  });
  assert.deepEqual(first, { ok: 1, skip: 0, fail: 0, mismatch: 0 });
  const destination = join(f.output, item.file);
  assert.deepEqual(readFileSync(destination), validHwpx);
  assert.equal(statSync(destination).mode & 0o077, 0);

  const second = await fetchGovCorpus({
    manifest: f.manifest,
    output: f.output,
    fetchImpl: async () => {
      throw new Error("network must not run");
    },
    logger: quietLogger,
  });
  assert.deepEqual(second, { ok: 0, skip: 1, fail: 0, mismatch: 0 });
});
