// issue 055 — 대형 합성 픽스처 생성기: benchmark1 을 시드로 ApplyContent(문단 4+표 1)×N 을 쌓아
// 대형 HWPX 를 만든다(N=220 → ~128p, N=880 → ~460p). measure-blocking.mjs 의 기본 입력.
// 산출물은 커밋하지 않는다(재생성 가능).
//   node apps/hwp-lab/scripts/make-large-fixture.mjs [N=220]   → benchmarks/synthetic-large-055.hwpx
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..", "..");
const { HwpDoc, initEngine } = await import(path.join(repoRoot, "packages", "engine", "index.js"));
await initEngine(readFileSync(path.join(repoRoot, "packages", "engine", "pkg", "hwp_wasm_bg.wasm")));

const doc = HwpDoc.open(new Uint8Array(readFileSync(path.join(repoRoot, "benchmarks", "benchmark1.hwp"))), "benchmark1.hwp");
console.log("seed pages:", doc.pageCount());

const para = (i) => ({
  type: "paragraph",
  runs: [{ text: `합성 문단 ${i} — 워커화 블로킹 실측용 본문입니다. 실제 사업계획서 흐름을 흉내 내어 충분히 긴 문장을 넣어 줄바꿈과 페이지 넘김이 계속 일어나게 한다. 지원 대상, 지원 내용, 신청 방법, 평가 기준, 유의 사항을 차례로 서술한다.` }],
});
const table = (i) => ({
  type: "table",
  header: ["항목", "내용", "비고"],
  rows: Array.from({ length: 6 }, (_, r) => [`${i}-${r} 항목`, `세부 내용 ${i}-${r} — 지원 규모와 집행 일정`, "확인"]),
});

const N = Number(process.argv[2] ?? 220);
for (let i = 0; i < N; i++) {
  const blocks = [para(`${i}a`), para(`${i}b`), table(i), para(`${i}c`), para(`${i}d`)];
  doc.applyIntent({ intent: "ApplyContent", json: JSON.stringify({ blocks }) });
}
const pages = doc.pageCount();
const bytes = doc.toHwpx();
const out = path.join(repoRoot, "benchmarks", "synthetic-large-055.hwpx");
writeFileSync(out, bytes);
console.log(`synthetic fixture: pages=${pages} bytes=${bytes.length} → ${out}`);
doc.free();
