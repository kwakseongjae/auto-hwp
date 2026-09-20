#!/usr/bin/env node
// Full-corpus layout-check sweep (issue #72 / T1-R2).
// Joins scores with corpus/typeset-coverage.json tags.
//
// Usage:
//   node scripts/oracle-sweep.mjs                 # run + write JSON/MD baseline
//   node scripts/oracle-sweep.mjs --check         # re-run, fail on score regression
//   node scripts/oracle-sweep.mjs --check-committed  # no layout-check; schema/summary only (CI)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCLAIMER,
  byTag,
  joinScore,
  lowestAxes,
  regressionErrors,
  renderMd,
  summarize,
  validateCommitted,
} from "./lib/oracle-score.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonOut = join(repo, "corpus", "typeset-oracle.json");
const mdOut = join(repo, "corpus", "TYPESET-ORACLE.md");
const coveragePath = join(repo, "corpus", "typeset-coverage.json");
const argv = process.argv.slice(2);
const check = argv.includes("--check");
const checkCommitted = argv.includes("--check-committed");

/**
 * **언제나 다시 빌드한다** (이슈 305).
 *
 * 예전에는 `target/release/auto-hwp` 가 있으면 **기능을 확인하지 않고 그대로 썼다.**
 * 그런데 그 자리에는 누가 무엇으로 빌드해 뒀을지 모른다 — 다른 작업을 하다
 * `--features rhwp` (shaper 없음)로 빌드해 두면, 스윕이 **approx 메트릭으로 채점**한다.
 *
 * 같은 문서·같은 코드라도 둘은 다른 숫자를 낸다(실측: `복학원서.hwp` 가
 * shaper 18줄 · approx 17줄). 그래서 게이트가 오래 빨간 채로 있었고, 나는 그것을
 * 「회귀」·「기계 차이」·「폰트」로 번갈아 오진했다. **cargo 는 증분이라 이미 맞게
 * 빌드돼 있으면 거의 공짜다** — 재사용해서 아낄 것이 없었다.
 */
function ensureCli() {
  const bin = join(repo, "target", "release", "auto-hwp");
  console.error("oracle-sweep: building auto-hwp (release, rhwp+shaper)…");
  const r = spawnSync(
    "cargo",
    ["build", "--release", "-p", "auto-hwp-cli", "--features", "rhwp,shaper"],
    { cwd: repo, stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("cargo build auto-hwp-cli failed");
  if (!existsSync(bin)) throw new Error(`oracle-sweep: ${bin} missing after build`);
  return bin;
}

function runLayoutJson(bin, paths) {
  const reports = [];
  const batch = 8;
  for (let i = 0; i < paths.length; i += batch) {
    const slice = paths.slice(i, i + batch);
    const r = spawnSync(bin, ["layout-check", "--json", ...slice], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0 && !r.stdout) {
      throw new Error(`layout-check --json failed: ${r.stderr || r.status}`);
    }
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) throw new Error("layout-check --json: expected JSON array");
    reports.push(...parsed);
  }
  return reports;
}

/**
 * 이 baseline 이 **어느 코드에서 나왔는지** (이슈 305).
 *
 * `generated_at` 은 날짜뿐이라, 어긋났을 때 「다른 기계인가 다른 코드인가」를 가릴 수 없었다.
 * 실제로 `corpus/hwp/복학원서.hwp` 항목은 최초 baseline(#250) 이후 **한 번도 다시 쓰이지
 * 않은 채** 남아 있었다 — #275 가 baseline 을 11줄만 부분 갱신하면서 건드리지 않았기 때문이다.
 * 그 사이 우리 줄수가 18 → 17 로 바뀌었고, 게이트는 그때부터 **줄곧 빨간 채로** 있었다.
 *
 * 워킹트리가 더러우면 `-dirty` 를 붙인다 — 그 SHA 로는 재현이 안 되기 때문이다.
 */
function generatingCommit() {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  if (sha.status !== 0) return "unknown";
  const head = sha.stdout.trim();
  // **baseline 자신은 세지 않는다** — 그것을 쓰는 것이 이 함수를 부르는 이유라서,
  // 포함하면 언제나 `-dirty` 가 된다.
  const dirty = spawnSync(
    "git",
    ["status", "--porcelain", "--", ".", ":!corpus/typeset-oracle.json", ":!corpus/TYPESET-ORACLE.md"],
    { cwd: repo, encoding: "utf8" },
  );
  return dirty.status === 0 && dirty.stdout.trim() ? `${head}-dirty` : head;
}

/**
 * 이 점수를 **무엇으로 쟀는가** — 보고서가 말하는 값을 그대로 옮긴다 (이슈 305).
 * 섞여 있으면(있을 수 없지만) 그대로 드러나도록 정렬해 이어 붙인다.
 */
function metricsKind(reports) {
  const kinds = [...new Set(reports.map((r) => r.metrics).filter(Boolean))].sort();
  return kinds.length === 1 ? kinds[0] : kinds.join("+") || "unknown";
}

function buildDoc(coverage, reports, presentRels) {
  const byFile = new Map();
  for (const r of reports) {
    const rel = relative(repo, r.file).split("\\").join("/");
    byFile.set(r.file, r);
    byFile.set(rel, r);
  }
  const documents = coverage.documents.map((c) => {
    const abs = join(repo, c.rel);
    const missing = !existsSync(abs);
    const cli = byFile.get(abs) || byFile.get(c.rel);
    return joinScore(c, cli, missing && c.collection === "gov");
  });
  documents.sort((a, b) => a.rel.localeCompare(b.rel));
  const by_tag = byTag(documents);
  const generated = {
    schema_version: 1,
    issue: 72,
    generated_at: new Date().toISOString().slice(0, 10),
    // 이슈 305 — 날짜만으로는 「다른 기계인가 다른 코드인가」를 못 가린다.
    commit: generatingCommit(),
    // 이슈 305 — **approx 로 잰 점수와 shaper 로 잰 점수는 다른 숫자다.** 어느 쪽인지
    // 적어 두지 않으면 어긋났을 때 「회귀」와 「다른 빌드」를 가를 수 없다.
    metrics: metricsKind(reports),
    command: "auto-hwp layout-check --json (features rhwp,shaper) + scripts/oracle-sweep.mjs",
    disclaimer: DISCLAIMER,
    note: "Scores lock today's stored-lineseg numbers. They are not Hangul ground truth. Unscorable converted HWPX is not a zero. corpus/private user docs are not listed. GOV binaries stay unreproduced in git.",
    coverage_issue: 71,
    present: presentRels,
    summary: summarize(documents),
    by_tag,
    lowest_axes: lowestAxes(by_tag, 3),
    documents,
  };
  return generated;
}

if (checkCommitted) {
  if (!existsSync(jsonOut) || !existsSync(mdOut)) {
    console.error("oracle-sweep --check-committed: corpus/typeset-oracle.json or TYPESET-ORACLE.md missing");
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(jsonOut, "utf8"));
  const errors = validateCommitted(doc);
  const md = readFileSync(mdOut, "utf8");
  if (!md.includes("참값")) errors.push("TYPESET-ORACLE.md must state scores are not Hangul ground truth");
  if (!md.includes("채점 불가")) errors.push("TYPESET-ORACLE.md must distinguish unscorable from zero");
  const rendered = renderMd(doc);
  const stripDate = (s) => s.replace(/생성 \d{4}-\d{2}-\d{2}/, "생성 DATE");
  if (stripDate(md) !== stripDate(rendered)) {
    errors.push("TYPESET-ORACLE.md drifted from typeset-oracle.json (re-run node scripts/oracle-sweep.mjs)");
  }
  if (errors.length) {
    for (const e of errors) console.error(`oracle-sweep --check-committed: ${e}`);
    process.exit(1);
  }
  console.log(
    `oracle-sweep --check-committed: ok (${doc.documents.length} docs, scorable=${doc.summary.scorable}, unscorable=${doc.summary.unscorable})`,
  );
  process.exit(0);
}

if (!existsSync(coveragePath)) {
  console.error("oracle-sweep: corpus/typeset-coverage.json missing (run node scripts/tag-corpus.mjs)");
  process.exit(1);
}
const coverage = JSON.parse(readFileSync(coveragePath, "utf8"));
const present = coverage.documents.filter((d) => existsSync(join(repo, d.rel)));
const bin = ensureCli();
const reports = present.length ? runLayoutJson(bin, present.map((d) => join(repo, d.rel))) : [];
const generated = buildDoc(coverage, reports, present.length);

if (existsSync(jsonOut)) {
  const previous = JSON.parse(readFileSync(jsonOut, "utf8"));
  const prevBy = new Map((previous.documents || []).map((d) => [d.rel, d]));
  generated.documents = generated.documents.map((d) => {
    const prev = prevBy.get(d.rel);
    if (d.verdict === "not-fetched" && prev && prev.score_kind !== "not-fetched") {
      return prev;
    }
    return d;
  });
  generated.summary = summarize(generated.documents);
  generated.by_tag = byTag(generated.documents);
  generated.lowest_axes = lowestAxes(generated.by_tag, 3);
}

if (check) {
  if (!existsSync(jsonOut)) {
    console.error("oracle-sweep --check: corpus/typeset-oracle.json missing — run without --check first");
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(jsonOut, "utf8"));
  const errors = regressionErrors(committed.documents, generated.documents);
  if (committed.documents.length !== generated.documents.length) {
    errors.unshift(
      `document count ${committed.documents.length} → ${generated.documents.length} (coverage drift)`,
    );
  }
  if (errors.length) {
    for (const e of errors) console.error(`oracle-sweep --check: ${e}`);
    process.exit(1);
  }
  console.log(
    `oracle-sweep --check: ok (${generated.documents.length} docs, scorable=${generated.summary.scorable}, unscorable=${generated.summary.unscorable})`,
  );
  process.exit(0);
}

mkdirSync(dirname(jsonOut), { recursive: true });
writeFileSync(jsonOut, `${JSON.stringify(generated, null, 2)}\n`);
writeFileSync(mdOut, renderMd(generated));
console.log(`oracle-sweep: ${generated.documents.length} docs → ${relative(repo, jsonOut)} · ${relative(repo, mdOut)}`);
console.log(
  `scorable=${generated.summary.scorable} unscorable=${generated.summary.unscorable} fail=${generated.summary.fail} not-fetched=${generated.summary.not_fetched} match=${generated.summary.match} line_gap=${generated.summary.line_gap} page_gap=${generated.summary.page_gap}`,
);
console.log(`disclaimer: ${DISCLAIMER}`);
const low = generated.lowest_axes || [];
if (low.length) {
  console.log(
    `lowest axes: ${low.map((r) => `${r.tag} line=${r.mean_line_exact_pct ?? "—"} page=${r.page_match_rate ?? "—"}`).join(" · ")}`,
  );
}
