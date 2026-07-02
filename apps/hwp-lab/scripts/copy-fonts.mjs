// copy-fonts.mjs — prebuild/predev hook (issue 022 §5).
// Copies the REPO-BUNDLED default font (assets/fonts/NanumGothic-Regular.ttf + Bold, OFL — OFL.txt
// alongside) into apps/hwp-lab/public/fonts/. Unlike fetch-fonts.mjs (dev-time catalog download),
// this is a repo asset, so the default font — and therefore the screen/PDF font system — works fully
// OFFLINE with no network. public/fonts is git-ignored; this repopulates it on every dev/build.
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");
const srcDir = path.join(repoRoot, "assets", "fonts");
const destDir = path.join(appRoot, "public", "fonts");

const files = ["NanumGothic-Regular.ttf", "NanumGothic-Bold.ttf", "OFL.txt"];

if (!existsSync(path.join(srcDir, files[0]))) {
  console.error(`\n[copy-fonts] 기본 폰트가 없습니다: ${path.join(srcDir, files[0])}\n레포 자산 assets/fonts/ 를 확인하세요.\n`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
for (const f of files) {
  const src = path.join(srcDir, f);
  if (!existsSync(src)) continue;
  const dest = path.join(destDir, f);
  cpSync(src, dest);
  const kb = Math.round(statSync(dest).size / 1024);
  console.log(`[copy-fonts] ${path.relative(repoRoot, src)} → ${path.relative(repoRoot, dest)} (${kb} KB)`);
}
