// copy-samples.mjs — prebuild/predev 훅 (OSS 데모 랜딩).
// 레포 벤치마크 문서(게이트가 잠그는 그 파일들)를 public/samples/ 로 복사해 랜딩의 "원클릭 샘플"
// 버튼이 fetch 할 수 있게 한다. public/samples 는 git-ignore — 이 스크립트가 매 dev/build 마다 채운다.
//  - sample-8p.hwp   ← benchmarks/benchmark.hwp   (정부 양식 8쪽, HWP5 바이너리)
//  - sample-18p.hwpx ← benchmarks/benchmark1.hwpx (신청서 18쪽 — 손실 변환 자동 감지/레이아웃 정리 데모)
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const repoRoot = path.join(appRoot, "..", "..");
const destDir = path.join(appRoot, "public", "samples");

const SAMPLES = [
  ["benchmarks/benchmark.hwp", "sample-8p.hwp"],
  ["benchmarks/benchmark1.hwpx", "sample-18p.hwpx"],
];

mkdirSync(destDir, { recursive: true });
for (const [src, dest] of SAMPLES) {
  const from = path.join(repoRoot, src);
  if (!existsSync(from)) {
    console.warn(`[copy-samples] 원본 없음 — 건너뜀: ${src}`);
    continue;
  }
  const to = path.join(destDir, dest);
  cpSync(from, to);
  const kb = Math.round(statSync(to).size / 1024);
  console.log(`[copy-samples] ${src} → public/samples/${dest} (${kb} KB)`);
}
