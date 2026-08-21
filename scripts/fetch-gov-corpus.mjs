#!/usr/bin/env node
// corpus/gov-sources.json 재현 스크립트 — KOGL 실측 검증된 공공문서를 **원 출처에서 직접**
// 내려받아 sha256 검증 후 corpus/private/bench-public/files/ 에 둔다(바이너리는 레포에 커밋하지
// 않는다 — 재배포 대신 재현: korea.kr 자유이용이 "텍스트 한정"이라 첨부 내 제3자 이미지 리스크 회피).
// 사용: node scripts/fetch-gov-corpus.mjs
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGovSources } from "./lib/gov-sources.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repo, "corpus", "private", "bench-public", "files");
const manifestPath = join(repo, "corpus", "gov-sources.json");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const items = loadGovSources(readFileSync(manifestPath, "utf8"));
if (items.length === 0) {
  console.error("fetch-gov-corpus: gov-sources.json 에 검증된 항목이 없다");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let ok = 0,
  skip = 0,
  fail = 0,
  mismatch = 0;

for (const item of items) {
  const dest = join(outDir, item.file);
  const want = String(item.sha256).toLowerCase();
  if (existsSync(dest)) {
    const have = sha256(readFileSync(dest));
    if (have === want) {
      skip++;
      continue;
    }
    console.log(`↻ ${item.file}: sha256 불일치 — 다시 받음`);
  }
  try {
    const res = await fetch(item.source_url, {
      redirect: "follow",
      headers: { "User-Agent": "auto-hwp-gov-corpus-fetch" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const magicOk =
      (buf[0] === 0x50 && buf[1] === 0x4b) || (buf[0] === 0xd0 && buf[1] === 0xcf);
    if (!magicOk) throw new Error("매직바이트 불일치(에러 페이지?)");
    const have = sha256(buf);
    if (have !== want) {
      mismatch++;
      throw new Error(`sha256 ${have} ≠ ${want}`);
    }
    writeFileSync(dest, buf);
    console.log(
      `✓ ${item.file} (${(buf.length / 1024).toFixed(0)}KB, ${item.kogl}, sha256 ${have.slice(0, 16)}…)`,
    );
    ok++;
  } catch (e) {
    console.log(
      `✗ ${item.file}: ${e.message ?? e} — source_page 에서 수동 확인: ${item.source_page ?? ""}`,
    );
    fail++;
  }
}
console.log(
  `\nfetch-gov-corpus: ${ok} 받음 · ${skip} 이미 있음(해시일치) · ${mismatch} 해시불일치 · ${fail} 실패`,
);
if (fail > 0) process.exit(1);
