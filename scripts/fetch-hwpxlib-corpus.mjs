#!/usr/bin/env node
// Fetch Apache-2.0 **sample data** from neolord0/hwpxlib (testFile/*.hwpx only).
// Clean-room: data yes, code no. Does not vendor Java sources.
//
// Usage: node scripts/fetch-hwpxlib-corpus.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(repo, "corpus", "hwpxlib_corpus");
const TREE = "https://api.github.com/repos/neolord0/hwpxlib/git/trees/main?recursive=1";
const RAW = "https://raw.githubusercontent.com/neolord0/hwpxlib/main/";
const LICENSE_RAW = RAW + "license.txt";

const headers = {
  "User-Agent": "auto-hwp-corpus-fetch",
  Accept: "application/vnd.github+json",
};

async function getJson(url) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

async function getBytes(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "auto-hwp-corpus-fetch" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const tree = await getJson(TREE);
const files = (tree.tree ?? []).filter(
  (t) =>
    t.type === "blob" &&
    typeof t.path === "string" &&
    t.path.startsWith("testFile/") &&
    t.path.toLowerCase().endsWith(".hwpx"),
);
if (files.length === 0) throw new Error("hwpxlib tree: no testFile/*.hwpx");

mkdirSync(outRoot, { recursive: true });
if (!existsSync(join(outRoot, "license.txt"))) {
  try {
    writeFileSync(join(outRoot, "license.txt"), await getBytes(LICENSE_RAW));
    console.log("✓ license.txt");
  } catch (e) {
    console.log(`! license.txt: ${e.message ?? e}`);
  }
}

let ok = 0,
  skip = 0,
  fail = 0;
for (const f of files) {
  const rel = f.path.slice("testFile/".length);
  const dest = join(outRoot, rel);
  if (existsSync(dest)) {
    skip++;
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  try {
    const buf = await getBytes(RAW + f.path);
    const magicOk = buf[0] === 0x50 && buf[1] === 0x4b;
    if (!magicOk) throw new Error("not a ZIP/HWPX");
    writeFileSync(dest, buf);
    console.log(`✓ ${rel} (${(buf.length / 1024).toFixed(0)}KB)`);
    ok++;
  } catch (e) {
    console.log(`✗ ${rel}: ${e.message ?? e}`);
    fail++;
  }
}
console.log(`\nfetch-hwpxlib-corpus: ${ok} 받음 · ${skip} 이미 있음 · ${fail} 실패 · 목록 ${files.length}`);
if (fail > 0) process.exit(1);
