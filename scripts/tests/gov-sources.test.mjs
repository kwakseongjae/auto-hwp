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

test("loadGovSources drops unverified and KOGL-4", () => {
  const items = loadGovSources(
    JSON.stringify({
      files: [
        {
          file: "a.hwpx",
          source_url: "https://example.test/a",
          source_page: "https://example.test/p",
          kogl: "KOGL-1",
          kogl_verified: false,
          sha256: "a".repeat(64),
        },
        {
          file: "b.hwpx",
          source_url: "https://example.test/b",
          source_page: "https://example.test/p",
          kogl: "KOGL-4",
          kogl_verified: true,
          sha256: "b".repeat(64),
        },
        {
          file: "c.hwpx",
          source_url: "https://example.test/c",
          source_page: "https://example.test/p",
          kogl: "KOGL-0",
          kogl_verified: true,
          sha256: "c".repeat(64),
        },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => i.file),
    ["c.hwpx"],
  );
});
