// fetch-fonts.mjs — DEV-TIME catalog font downloader (issue 022 §5).
//
// Downloads the curated OFL catalog (docs/FONT-CATALOG.md — every entry is redistribution-legal, R8)
// into `apps/hwp-lab/public/fonts/` (GIT-IGNORED — fonts are never committed). Each entry pins an
// official source URL + a sha256; the script VERIFIES the hash after download (tamper/typo guard) and
// prints the computed hash when a pin is missing so a maintainer can record it. Network failures are
// NON-FATAL: the entry is skipped with a clear reason and the app still works offline on the repo-
// bundled default (NanumGothic, copied by copy-fonts.mjs). The default NanumGothic is NOT fetched here.
//
// Run:  node apps/hwp-lab/scripts/fetch-fonts.mjs   (from the repo root or the app dir)

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const outDir = path.join(appRoot, "public", "fonts");

// The curated catalog (family / saved filename / official source URL / pinned sha256). All OFL — see
// docs/FONT-CATALOG.md for the license table + original-source links (R8 hard gate). NanumGothic is the
// repo-bundled default (copy-fonts.mjs) and is intentionally absent here.
const CATALOG = [
  {
    family: "Nanum Myeongjo",
    file: "NanumMyeongjo-Regular.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/nanummyeongjo/NanumMyeongjo-Regular.ttf",
    sha256: "7ed9e8653a8ed04285d51dc343ffea6eb3d9c73afc27383ea8929ee4ffd03205",
  },
  {
    family: "Noto Sans KR",
    file: "NotoSansKR-Regular.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf",
    sha256: "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252",
  },
  {
    family: "Noto Serif KR",
    file: "NotoSerifKR-Regular.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifkr/NotoSerifKR%5Bwght%5D.ttf",
    sha256: "11f8d5de6f1b79195efba3828aaa2ec95c1178f5ae976fb23c8d53250a9938f3",
  },
  {
    family: "IBM Plex Sans KR",
    file: "IBMPlexSansKR-Regular.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsanskr/IBMPlexSansKR-Regular.ttf",
    sha256: "53750379270312368cf7641901f43a98dd892e3d9d5798cf25cdc245c85c71c0",
  },
  {
    family: "Gowun Dodum",
    file: "GowunDodum-Regular.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/gowundodum/GowunDodum-Regular.ttf",
    sha256: "a6e457933227483a11758fd0947bc74422a106d46f0bf057fdaa5af94a30067d",
  },
  {
    family: "Gowun Batang",
    file: "GowunBatang-Regular.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/gowunbatang/GowunBatang-Regular.ttf",
    sha256: "466c593e7147412e748af4856d5ad14709b5a860bdf62b9c2546f2c5874e9849",
  },
  {
    family: "Pretendard",
    file: "Pretendard-Regular.otf",
    url: "https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/Pretendard-Regular.otf",
    sha256: "3ffbacde6ab8411f1d2db54bb9b1f0b3ee2a738932033722cf0388c06aed1c93",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isPinned = (s) => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);

async function main() {
  mkdirSync(outDir, { recursive: true });
  let ok = 0;
  let skipped = 0;
  let mismatched = 0;
  for (const e of CATALOG) {
    const dest = path.join(outDir, e.file);
    if (existsSync(dest) && statSync(dest).size > 0) {
      console.log(`[fetch-fonts] 이미 존재: ${e.file} (${Math.round(statSync(dest).size / 1024)} KB) — 건너뜀`);
      ok++;
      continue;
    }
    try {
      const res = await fetch(e.url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (isPinned(e.sha256)) {
        if (got !== e.sha256) {
          mismatched++;
          console.error(`[fetch-fonts] ✗ ${e.family}: sha256 불일치!\n  기대: ${e.sha256}\n  실제: ${got}\n  → 저장하지 않음(변조/URL 변경 의심).`);
          continue;
        }
      } else {
        console.warn(`[fetch-fonts] ⚠ ${e.family}: sha256 핀이 없습니다 — 아래 값을 스크립트에 기록하세요:\n  ${e.file}  sha256=${got}`);
      }
      writeFileSync(dest, buf);
      ok++;
      console.log(`[fetch-fonts] ✓ ${e.family} → public/fonts/${e.file} (${Math.round(buf.length / 1024)} KB, sha256=${got.slice(0, 12)}…)`);
    } catch (err) {
      skipped++;
      console.warn(`[fetch-fonts] – ${e.family} 건너뜀 (네트워크/URL 문제: ${err.message}). 앱은 기본 NanumGothic으로 동작합니다.`);
    }
  }
  console.log(`\n[fetch-fonts] 완료: 성공 ${ok} · 건너뜀 ${skipped} · 해시불일치 ${mismatched} / 총 ${CATALOG.length}`);
  console.log(`[fetch-fonts] 다운로드 위치: ${path.relative(process.cwd(), outDir)} (git 제외 — 커밋되지 않음)`);
  if (mismatched > 0) process.exitCode = 1;
}

main();
