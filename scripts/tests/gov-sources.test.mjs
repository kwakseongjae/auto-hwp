import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGovSources } from "../lib/gov-sources.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("gov-sources.json loads only KOGL-0/1 with full sha256", () => {
  const items = loadGovSources(readFileSync(join(repo, "corpus", "gov-sources.json"), "utf8"));
  assert.ok(items.length >= 7, `expected ≥7 verified gov sources, got ${items.length}`);
  for (const i of items) {
    assert.match(i.kogl, /^KOGL-[01]/);
    assert.equal(i.kogl_verified, true);
    assert.match(i.sha256, /^[0-9a-f]{64}$/i);
    assert.ok(i.source_url.startsWith("https://"));
    assert.ok(i.source_page.startsWith("https://"));
  }
  const kinds = new Set(items.map((i) => i.kind));
  assert.ok(
    [...kinds].some((k) => String(k).includes("양식") || String(k).includes("서식")),
    "GOV-SOURCES must include at least one 양식/서식 after T1-R1 bias fix",
  );
});

test("loadGovSources fails closed on unverified and non-redistributable rows", () => {
  const base = {
    file: "sample.hwpx",
    publisher: "기관",
    kind: "양식",
    source_url: "https://example.test/a",
    source_page: "https://example.test/p",
    kogl: "KOGL-1",
    kogl_verified: true,
    sha256: "a".repeat(64),
  };
  for (const patch of [{ kogl_verified: false }, { kogl: "KOGL-4" }, { kogl: "KOGL-1-extra" }]) {
    assert.throws(
      () =>
        loadGovSources(
          JSON.stringify({ schema_version: 1, files: [{ ...base, ...patch }] }),
        ),
      /verified exact KOGL-0\/1 required/,
    );
  }
});

test("loadGovSources rejects traversal, non-document names, and duplicate destinations", () => {
  const base = {
    file: "sample.hwpx",
    publisher: "기관",
    kind: "양식",
    source_url: "https://example.test/a",
    source_page: "https://example.test/p",
    kogl: "KOGL-1",
    kogl_verified: true,
    sha256: "a".repeat(64),
  };
  for (const [patch, message] of [
    [{ file: "../sample.hwpx" }, /basename only/],
    [{ file: "..\\sample.hwpx" }, /basename only/],
    [{ file: "CON.hwp" }, /Windows-compatible/],
    [{ file: "sample.pdf" }, /\.hwp or \.hwpx required/],
    [{ file: "e\u0301.hwpx" }, /NFC-normalized/],
    [{ sha256: "abc" }, /full SHA-256/],
    [{ source_url: "http://example.test/a" }, /HTTPS without credentials/],
    [{ unknown: true }, /unknown field/],
  ]) {
    assert.throws(
      () =>
        loadGovSources(
          JSON.stringify({ schema_version: 1, files: [{ ...base, ...patch }] }),
        ),
      message,
    );
  }
  assert.throws(
    () =>
      loadGovSources(
        JSON.stringify({
          schema_version: 1,
          files: [base, { ...base, source_url: "https://example.test/b" }],
        }),
      ),
    /duplicate sample\.hwpx/,
  );
});
