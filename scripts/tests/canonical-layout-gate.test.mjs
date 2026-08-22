import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_LAYOUT_GATES,
  canonicalLayoutGateErrors,
} from "../lib/canonical-layout-gate.mjs";

function validReport(name) {
  const requirement = CANONICAL_LAYOUT_GATES[name];
  return {
    file: `benchmarks/${name}`,
    ok: true,
    score_kind: "scorable",
    verdict: "match",
    our_pages: requirement.pages,
    oracle_pages: requirement.pages,
    page_match: true,
    body_paragraphs_with_oracle: requirement.bodyOracleMin,
    body_paragraphs_missing_oracle: 0,
    line_exact_pct: 98.9,
  };
}

function validReports() {
  return Object.keys(CANONICAL_LAYOUT_GATES).map(validReport);
}

test("accepts exactly the three canonical reports at their floors", () => {
  assert.deepEqual(canonicalLayoutGateErrors(validReports()), []);
});

test("accepts absolute canonical benchmark paths", () => {
  const reports = validReports();
  reports[0].file = `/checkout/auto-hwp/${reports[0].file}`;
  assert.deepEqual(canonicalLayoutGateErrors(reports), []);
});

test("rejects a missing canonical report", () => {
  const errors = canonicalLayoutGateErrors(validReports().slice(0, 2));
  assert.ok(errors.some((error) => error.includes("benchmark2.hwp: missing report")));
});

test("rejects duplicate and unknown reports", () => {
  const reports = validReports();
  reports.push(validReport("benchmark.hwp"));
  reports.push({ ...validReport("benchmark.hwp"), file: "benchmarks/unexpected.hwp" });
  const errors = canonicalLayoutGateErrors(reports);
  assert.ok(errors.some((error) => error.includes("benchmark.hwp: duplicate report")));
  assert.ok(errors.some((error) => error.includes("unknown benchmark path")));
});

test("rejects unscorable output instead of treating it as zero or a match", () => {
  const reports = validReports();
  Object.assign(reports[0], {
    score_kind: "unscorable",
    verdict: "unscorable",
    page_match: null,
    line_exact_pct: null,
  });
  const errors = canonicalLayoutGateErrors(reports);
  assert.ok(errors.some((error) => error.includes("score_kind must be scorable")));
  assert.ok(errors.some((error) => error.includes("verdict must be match")));
  assert.ok(errors.some((error) => error.includes("line_exact_pct must be a finite number")));
});

test("rejects 7==7 even when layout-check says match", () => {
  const reports = validReports();
  Object.assign(reports[0], { our_pages: 7, oracle_pages: 7 });
  const errors = canonicalLayoutGateErrors(reports);
  assert.ok(errors.some((error) => error.includes("our_pages must be exactly 8")));
  assert.ok(errors.some((error) => error.includes("oracle_pages must be exactly 8")));
});

test("rejects line accuracy below 98.9 percent", () => {
  const reports = validReports();
  reports[1].line_exact_pct = 98.8;
  const errors = canonicalLayoutGateErrors(reports);
  assert.ok(errors.some((error) => error.includes("line_exact_pct 98.8 < 98.9")));
});

test("rejects body oracle loss", () => {
  const reports = validReports();
  reports[2].body_paragraphs_with_oracle = 364;
  reports[2].body_paragraphs_missing_oracle = 1;
  const errors = canonicalLayoutGateErrors(reports);
  assert.ok(errors.some((error) => error.includes("body_paragraphs_with_oracle must be >= 365")));
  assert.ok(errors.some((error) => error.includes("body_paragraphs_missing_oracle must be 0")));
});

test("rejects a non-array JSON root", () => {
  assert.deepEqual(canonicalLayoutGateErrors({}), ["layout-check JSON root must be an array"]);
});
