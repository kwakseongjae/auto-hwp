import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCLAIMER,
  byTag,
  cliReportsToTsv,
  joinScore,
  lowestAxes,
  regressionErrors,
  summarize,
  validateCommitted,
} from "../lib/oracle-score.mjs";

test("disclaimer states stored-lineseg lock, not Hangul truth", () => {
  assert.match(DISCLAIMER, /참값/);
  assert.match(DISCLAIMER, /lineseg/);
});

test("unscorable is not mixed into tag averages as a zero", () => {
  const docs = [
    {
      rel: "a.hwp",
      score_kind: "scorable",
      verdict: "line_gap",
      page_match: true,
      line_exact_pct: 40,
      cell_exact_pct: 80,
      tags: { header_footer: true, form_control: false },
    },
    {
      rel: "b.hwpx",
      score_kind: "unscorable",
      verdict: "unscorable",
      page_match: null,
      line_exact_pct: null,
      cell_exact_pct: null,
      tags: { header_footer: true, form_control: true },
    },
    {
      rel: "c.hwp",
      score_kind: "fail",
      verdict: "fail",
      page_match: null,
      line_exact_pct: 0,
      tags: { header_footer: true },
    },
  ];
  const tags = byTag(docs);
  assert.equal(tags.header_footer.tagged, 3);
  assert.equal(tags.header_footer.scorable, 1);
  assert.equal(tags.header_footer.unscorable, 1);
  assert.equal(tags.header_footer.mean_line_exact_pct, 40);
  assert.equal(tags.header_footer.mean_cell_exact_pct, 80);
  assert.equal(tags.form_control.scorable, 0);
  assert.equal(tags.form_control.mean_line_exact_pct, null);
  const sum = summarize(docs);
  assert.equal(sum.scorable, 1);
  assert.equal(sum.unscorable, 1);
  assert.equal(sum.fail, 1);
  assert.equal(sum.mean_line_exact_pct, 40);
});

test("lowest axes skip empty tags and sort by line exact", () => {
  const by_tag = byTag([
    {
      rel: "n.hwp",
      score_kind: "scorable",
      verdict: "page_gap",
      page_match: false,
      line_exact_pct: 10,
      tags: { nested_table: true },
    },
    {
      rel: "h.hwp",
      score_kind: "scorable",
      verdict: "match",
      page_match: true,
      line_exact_pct: 99,
      tags: { header_footer: true },
    },
    {
      rel: "f.hwp",
      score_kind: "scorable",
      verdict: "line_gap",
      page_match: true,
      line_exact_pct: 50,
      tags: { form_control: true },
    },
  ]);
  const low = lowestAxes(by_tag, 3);
  assert.equal(low[0].tag, "nested_table");
  assert.equal(low[1].tag, "form_control");
  assert.equal(low[2].tag, "header_footer");
  assert.ok(!low.some((r) => r.tag === "mixed_orientation"));
});

test("regression fails on page/line drop but not on missing GOV", () => {
  const base = [
    {
      rel: "ok.hwp",
      score_kind: "scorable",
      verdict: "match",
      ok: true,
      page_match: true,
      line_exact_pct: 99,
      cell_exact_pct: 100,
      sha256: "aa",
    },
    {
      rel: "gov.hwpx",
      score_kind: "scorable",
      verdict: "match",
      ok: true,
      page_match: true,
      line_exact_pct: 90,
      sha256: "bb",
    },
  ];
  const liveOk = [
    { ...base[0] },
    { rel: "gov.hwpx", score_kind: "not-fetched", verdict: "not-fetched", sha256: "bb" },
  ];
  assert.deepEqual(regressionErrors(base, liveOk), []);

  const liveDrop = [
    {
      rel: "ok.hwp",
      score_kind: "scorable",
      verdict: "page_gap",
      ok: true,
      page_match: false,
      line_exact_pct: 80,
      cell_exact_pct: 100,
      sha256: "aa",
    },
    { ...base[1] },
  ];
  const err = regressionErrors(base, liveDrop);
  assert.ok(err.some((e) => e.includes("page_match")));
  assert.ok(err.some((e) => e.includes("line_exact_pct")));
});

test("joinScore marks converted-cache absence via CLI kind, not a 0%", () => {
  const coverage = {
    rel: "corpus/hwpx/Skeleton.hwpx",
    collection: "corpus-hwpx",
    sha256: "cc",
    tags: {},
  };
  const joined = joinScore(coverage, {
    format: "hwpx",
    ok: true,
    score_kind: "unscorable",
    verdict: "unscorable",
    our_pages: 1,
    oracle_pages: 1,
    page_match: null,
    paragraphs: 4,
    body_paragraphs_with_oracle: 0,
    line_exact_pct: null,
    cell_exact_pct: null,
    cell_paragraphs: 0,
  }, false);
  assert.equal(joined.verdict, "unscorable");
  assert.equal(joined.line_exact_pct, null);
  assert.equal(joined.page_match, null);
});

test("tsv keeps dash for unscorable instead of 0", () => {
  const tsv = cliReportsToTsv([
    {
      file: "/tmp/a.hwpx",
      verdict: "unscorable",
      score_kind: "unscorable",
      our_pages: 1,
      oracle_pages: 1,
      page_match: null,
      paragraphs: 3,
      line_exact_pct: null,
      cell_paragraphs: 0,
      cell_exact_pct: null,
    },
  ]);
  assert.match(tsv, /\tunscorable\t/);
  assert.doesNotMatch(tsv.split("\n")[1], /\t0\t0$/);
  assert.match(tsv, /\t—\t/);
});

test("committed fixture with mixed 0 on unscorable fails validation", () => {
  const bad = {
    schema_version: 1,
    issue: 72,
    disclaimer: DISCLAIMER,
    documents: [
      {
        rel: "x.hwpx",
        score_kind: "unscorable",
        verdict: "unscorable",
        line_exact_pct: 0,
        page_match: false,
      },
    ],
    summary: summarize([]),
  };
  const errors = validateCommitted(bad);
  assert.ok(errors.some((e) => e.includes("unscorable")));
});

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("if typeset-oracle.json exists, it is internally consistent", () => {
  const p = join(repo, "corpus", "typeset-oracle.json");
  try {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    const errors = validateCommitted(doc);
    assert.deepEqual(errors, []);
  } catch (e) {
    if (e.code === "ENOENT") {
      assert.ok(true, "baseline not written yet");
      return;
    }
    throw e;
  }
});
