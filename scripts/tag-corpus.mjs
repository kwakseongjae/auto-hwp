#!/usr/bin/env node
// Reproducible typesetting-element coverage map (issue #71).
// Discovers committed + GOV-SOURCES files, opens each via `auto-hwp tag-layout`, writes
// corpus/typeset-coverage.json + corpus/TYPESET-COVERAGE.md.
//
// Usage:
//   node scripts/tag-corpus.mjs              # retag + write
//   node scripts/tag-corpus.mjs --check      # retag and fail if committed JSON drifts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGovSources } from "./lib/gov-sources.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const jsonOut = join(repo, "corpus", "typeset-coverage.json");
const mdOut = join(repo, "corpus", "TYPESET-COVERAGE.md");
const TAGS = [
  "header_footer",
  "form_control",
  "mixed_orientation",
  "nested_table",
  "multipage_table",
  "footnote",
  "multicolumn",
  "chart",
  "equation",
  "shape_ole",
];
const TAG_KO = {
  header_footer: "머리말/꼬리말",
  form_control: "폼 컨트롤",
  mixed_orientation: "가로세로 혼합",
  nested_table: "중첩 표",
  multipage_table: "다쪽 표",
  footnote: "각주",
  multicolumn: "다단",
  chart: "차트",
  equation: "수식",
  shape_ole: "도형/OLE",
};
// Oracle-silent axes first (§0 / #42), then T2 height axes, then the rest.
const PRIORITY = [
  "form_control",
  "header_footer",
  "mixed_orientation",
  "nested_table",
  "multipage_table",
  "footnote",
  "multicolumn",
  "chart",
  "equation",
  "shape_ole",
];

function walkHwpx(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkHwpx(p, acc);
    else if (/\.(hwp|hwpx)$/i.test(name)) acc.push(p);
  }
  return acc;
}

function sha256file(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function discover() {
  const files = [];
  const add = (abs, collection) => {
    if (!existsSync(abs)) return;
    files.push({
      path: abs,
      rel: relative(repo, abs).split("\\").join("/"),
      collection,
    });
  };
  for (const name of readdirSync(join(repo, "benchmarks")).sort()) {
    if (!/\.(hwp|hwpx)$/i.test(name)) continue;
    add(join(repo, "benchmarks", name), "benchmark");
  }
  for (const name of readdirSync(join(repo, "corpus", "hwp")).sort()) {
    add(join(repo, "corpus", "hwp", name), "corpus-hwp");
  }
  for (const name of readdirSync(join(repo, "corpus", "hwpx")).sort()) {
    add(join(repo, "corpus", "hwpx", name), "corpus-hwpx");
  }
  const sample = join(repo, "corpus", "sample.hwpx");
  if (existsSync(sample)) add(sample, "corpus-hwpx");
  for (const p of walkHwpx(join(repo, "corpus", "hwpxlib_corpus"))) {
    add(p, "hwpxlib");
  }
  const govJson = readFileSync(join(repo, "corpus", "gov-sources.json"), "utf8");
  const govItems = loadGovSources(govJson);
  const govDir = join(repo, "corpus", "private", "bench-public", "files");
  for (const item of govItems) {
    add(join(govDir, item.file), "gov");
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, govItems };
}

function oracleAxis(rel) {
  if (
    rel === "benchmarks/benchmark.hwp" ||
    rel === "benchmarks/benchmark1.hwp" ||
    rel === "benchmarks/benchmark2.hwp"
  ) {
    return "layout-check-gate";
  }
  if (
    rel === "benchmarks/benchmark1.hwpx" ||
    rel === "corpus/hwpx/FormattingShowcase.hwpx" ||
    rel === "corpus/hwpx/footnote-01.hwpx"
  ) {
    return "layout-check-hwpx-lock";
  }
  return "none";
}

function ensureCli() {
  const bin = join(repo, "target", "release", "auto-hwp");
  if (existsSync(bin)) return bin;
  console.error("tag-corpus: building auto-hwp (release, rhwp+shaper)…");
  const r = spawnSync(
    "cargo",
    ["build", "--release", "-p", "auto-hwp-cli", "--features", "rhwp,shaper"],
    { cwd: repo, stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("cargo build auto-hwp-cli failed");
  return bin;
}

function runTagLayout(bin, paths) {
  const reports = [];
  const batch = 24;
  for (let i = 0; i < paths.length; i += batch) {
    const slice = paths.slice(i, i + batch);
    const r = spawnSync(bin, ["tag-layout", ...slice], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0) {
      throw new Error(`tag-layout failed: ${r.stderr || r.stdout || r.status}`);
    }
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) throw new Error("tag-layout: expected JSON array");
    reports.push(...parsed);
  }
  return reports;
}

function renderMd(doc) {
  const lines = [];
  lines.push("# 조판 코퍼스 커버리지 지도");
  lines.push("");
  lines.push(
    `재현: \`node scripts/tag-corpus.mjs\` (이슈 #71). 생성 ${doc.generated_at}. 태그는 파일명 추정이 아니라 \`auto-hwp tag-layout\`이 파일을 열어 확인한 결과다.`,
  );
  lines.push("");
  lines.push("요소 태깅 지도다. 줄 단위 정합 점수는 `corpus/TYPESET-ORACLE.md`(이슈 #72, `node scripts/oracle-sweep.mjs`)가 전수 채점한다. 빈칸 우선순위는 TYPESET-ROADMAP §0의 침묵 축이 먼저다.");
  lines.push("");
  lines.push("## 문서 수");
  lines.push("");
  lines.push("| 수집 | 문서 | 비고 |");
  lines.push("|---|---:|---|");
  for (const [k, n] of Object.entries(doc.collections)) {
    lines.push(`| \`${k}\` | ${n} | |`);
  }
  lines.push(`| **합계** | **${doc.documents.length}** | ok ${doc.ok} · fail ${doc.fail} |`);
  lines.push("");
  lines.push("## 태그 분포 (문서 수)");
  lines.push("");
  lines.push("| 축 | 한국어 | 있음 | 없음 |");
  lines.push("|---|---|---:|---:|");
  for (const t of TAGS) {
    const n = doc.tag_counts[t] ?? 0;
    lines.push(`| \`${t}\` | ${TAG_KO[t]} | ${n} | ${doc.documents.length - n} |`);
  }
  lines.push("");
  lines.push("## 빈칸 (커버리지 0~1건) — 우선순위");
  lines.push("");
  lines.push("| 우선 | 축 | 건수 | 왜 먼저인가 |");
  lines.push("|---:|---|---:|---|");
  for (const g of doc.gaps) {
    lines.push(`| ${g.priority} | \`${g.tag}\` (${TAG_KO[g.tag]}) | ${g.count} | ${g.why} |`);
  }
  if (doc.gaps.length === 0) {
    lines.push("| — | (0~1건 축 없음) | — | 모든 축이 2건 이상. 공공 양식 편향은 GOV-SOURCES kind 분포로 따로 본다. |");
  }
  lines.push("");
  lines.push("## 문서별 태그");
  lines.push("");
  lines.push("| 파일 | 수집 | 오라클 | 태그 |");
  lines.push("|---|---|---|---|");
  for (const d of doc.documents) {
    const hit = !d.ok
      ? `FAIL: ${(d.error || "error").split("\n")[0].slice(0, 80)}`
      : TAGS.filter((t) => d.tags?.[t]).join(", ") || "—";
    const name = d.rel.replace(/\|/g, "\\|");
    lines.push(`| \`${name}\` | ${d.collection} | ${d.oracle_axis} | ${hit} |`);
  }
  lines.push("");
  lines.push("GOV 바이너리는 커밋하지 않는다. 재현: `node scripts/fetch-gov-corpus.mjs`.");
  lines.push("");
  return lines.join("\n");
}

const { files, govItems } = discover();
const missingGov = govItems.filter(
  (i) => !existsSync(join(repo, "corpus", "private", "bench-public", "files", i.file)),
);
const bin = ensureCli();
const present = files.filter((f) => existsSync(f.path));
const reports = present.length ? runTagLayout(bin, present.map((f) => f.path)) : [];
const byPath = new Map(reports.map((r) => [r.file, r]));

const documents = [];
for (const f of present) {
  const r = byPath.get(f.path) ?? byPath.get(f.rel);
  if (!r) {
    documents.push({
      rel: f.rel,
      collection: f.collection,
      oracle_axis: oracleAxis(f.rel),
      format: "unknown",
      ok: false,
      error: "tag-layout did not return this path",
      tags: Object.fromEntries(TAGS.map((t) => [t, false])),
      sha256: sha256file(f.path),
    });
    continue;
  }
  documents.push({
    rel: f.rel,
    collection: f.collection,
    oracle_axis: oracleAxis(f.rel),
    format: r.format,
    ok: r.ok,
    error: r.error ?? null,
    tags: r.tags,
    counts: r.counts,
    evidence: r.evidence,
    sections: r.sections,
    placed_pages: r.placed_pages,
    sha256: sha256file(f.path),
  });
}
for (const item of missingGov) {
  documents.push({
    rel: `corpus/private/bench-public/files/${item.file}`,
    collection: "gov",
    oracle_axis: "none",
    format: item.file.endsWith(".hwp") ? "hwp5" : "hwpx",
    ok: false,
    error: "not-fetched (run node scripts/fetch-gov-corpus.mjs)",
    tags: Object.fromEntries(TAGS.map((t) => [t, false])),
    sha256: item.sha256,
  });
}
documents.sort((a, b) => a.rel.localeCompare(b.rel));

const tag_counts = Object.fromEntries(TAGS.map((t) => [t, 0]));
for (const d of documents) {
  if (!d.ok) continue;
  for (const t of TAGS) if (d.tags?.[t]) tag_counts[t] += 1;
}
const collections = {};
for (const d of documents) collections[d.collection] = (collections[d.collection] ?? 0) + 1;

const why = {
  form_control: "§0/#42 — 쪽수 게이트가 침묵하는 축 (폼 컨트롤 소실)",
  header_footer: "§0/#42 — 머리말 표 소실",
  mixed_orientation: "§0/#42 — 가로·세로 페이지 공존 미적용",
  nested_table: "T2 — benchmark1 페이지 인플레이션의 기지 리스크",
  multipage_table: "T2 — 줄 단위 오라클이 아직 안 보는 다쪽 표 누적 높이",
  footnote: "T2 후보 — layout-check 확장 축",
  multicolumn: "조판 폭 계산. 표본 부족 시 일반화 금지",
  chart: "렌더 스텁/밴드. 오라클 밖",
  equation: "렌더 스텁. 오라클 밖",
  shape_ole: "도형/OLE. 오라클 밖",
};
const gaps = [];
let prio = 1;
for (const t of PRIORITY) {
  const n = tag_counts[t] ?? 0;
  if (n <= 1) {
    gaps.push({ priority: prio++, tag: t, count: n, why: why[t] });
  }
}

const generated = {
  schema_version: 1,
  issue: 71,
  generated_at: new Date().toISOString().slice(0, 10),
  command: "auto-hwp tag-layout (features rhwp,shaper) + scripts/tag-corpus.mjs",
  note: "Tags are from opening each file. Filenames are not evidence. corpus/private user docs are not listed. GOV binaries stay unreproduced in git.",
  collections,
  tag_counts,
  ok: documents.filter((d) => d.ok).length,
  fail: documents.filter((d) => !d.ok).length,
  gaps,
  documents,
};

const jsonText = `${JSON.stringify(generated, null, 2)}\n`;
const mdText = renderMd(generated);

if (check) {
  if (!existsSync(jsonOut)) {
    console.error("tag-corpus --check: corpus/typeset-coverage.json missing");
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(jsonOut, "utf8"));
  const strip = (d) => {
    const { generated_at, ...rest } = d;
    return rest;
  };
  const a = JSON.stringify(strip(committed));
  const b = JSON.stringify(strip(generated));
  if (a !== b) {
    console.error("tag-corpus --check: coverage JSON drifted. Re-run node scripts/tag-corpus.mjs");
    process.exit(1);
  }
  console.log(`tag-corpus --check: ok (${documents.length} docs)`);
  process.exit(0);
}

writeFileSync(jsonOut, jsonText);
writeFileSync(mdOut, mdText);
console.log(`tag-corpus: ${documents.length} docs → ${relative(repo, jsonOut)} · ${relative(repo, mdOut)}`);
console.log(
  `tags: ${TAGS.map((t) => `${t}=${tag_counts[t]}`).join(" · ")}`,
);
if (missingGov.length) {
  console.log(`gov not fetched: ${missingGov.length} (run node scripts/fetch-gov-corpus.mjs)`);
}
