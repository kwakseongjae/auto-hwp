/** Pure scoring/aggregation for the layout-check corpus sweep (issue #72). */

export const DISCLAIMER =
  "한/글의 참값이 아니라 저장 lineseg 기준의 회귀 잠금이다. HWPX 축 게이트와 같은 규율 — 참값 오라클은 이슈 075 몫.";

export const TAGS = [
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

export const TAG_KO = {
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

export const VERDICT_KO = {
  match: "일치",
  line_gap: "줄격차",
  page_gap: "쪽격차",
  unscorable: "채점불가",
  fail: "실패",
  "not-fetched": "미반입",
};

const VERDICT_RANK = { match: 0, line_gap: 1, page_gap: 2, fail: 3 };

export function mean(nums) {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

export function summarize(documents) {
  const counts = {
    documents: documents.length,
    scorable: 0,
    unscorable: 0,
    fail: 0,
    not_fetched: 0,
    match: 0,
    line_gap: 0,
    page_gap: 0,
  };
  const line = [];
  const cell = [];
  for (const d of documents) {
    const k = d.score_kind || d.verdict;
    if (k === "not-fetched") counts.not_fetched += 1;
    else if (k === "fail" || d.verdict === "fail") counts.fail += 1;
    else if (k === "unscorable" || d.verdict === "unscorable") counts.unscorable += 1;
    else counts.scorable += 1;
    if (d.verdict === "match") counts.match += 1;
    if (d.verdict === "line_gap") counts.line_gap += 1;
    if (d.verdict === "page_gap") counts.page_gap += 1;
    if (d.score_kind === "scorable" && typeof d.line_exact_pct === "number") line.push(d.line_exact_pct);
    if (d.score_kind === "scorable" && typeof d.cell_exact_pct === "number") cell.push(d.cell_exact_pct);
  }
  return {
    ...counts,
    mean_line_exact_pct: mean(line),
    mean_cell_exact_pct: mean(cell),
  };
}

export function byTag(documents) {
  const out = {};
  for (const t of TAGS) {
    const tagged = documents.filter((d) => d.tags?.[t]);
    const scorable = tagged.filter((d) => d.score_kind === "scorable");
    const line = scorable
      .map((d) => d.line_exact_pct)
      .filter((n) => typeof n === "number");
    const cell = scorable
      .map((d) => d.cell_exact_pct)
      .filter((n) => typeof n === "number");
    const pageHits = scorable.filter((d) => d.page_match === true).length;
    out[t] = {
      tag: t,
      tagged: tagged.length,
      scorable: scorable.length,
      unscorable: tagged.filter((d) => d.verdict === "unscorable").length,
      fail: tagged.filter((d) => d.verdict === "fail").length,
      page_match: pageHits,
      page_match_rate: scorable.length ? Math.round((1000 * pageHits) / scorable.length) / 10 : null,
      mean_line_exact_pct: mean(line),
      mean_cell_exact_pct: mean(cell),
    };
  }
  return out;
}

/** Lowest-scoring tagged axes first. Null means "no scorable sample", not 0. */
export function lowestAxes(by_tag, n = 3) {
  const rows = TAGS.map((t) => by_tag[t]).filter((r) => r && r.scorable > 0);
  rows.sort((a, b) => {
    const la = a.mean_line_exact_pct;
    const lb = b.mean_line_exact_pct;
    if (la == null && lb == null) {
      return (a.page_match_rate ?? 100) - (b.page_match_rate ?? 100);
    }
    if (la == null) return 1;
    if (lb == null) return -1;
    if (la !== lb) return la - lb;
    return (a.page_match_rate ?? 100) - (b.page_match_rate ?? 100);
  });
  return rows.slice(0, n);
}

export function regressionErrors(baselineDocs, liveDocs) {
  const errors = [];
  const liveBy = new Map(liveDocs.map((d) => [d.rel, d]));
  for (const b of baselineDocs) {
    const live = liveBy.get(b.rel);
    if (!live) {
      errors.push(`${b.rel}: missing from live sweep`);
      continue;
    }
    if (live.verdict === "not-fetched" || live.score_kind === "not-fetched") {
      continue;
    }
    if (b.verdict === "not-fetched" || b.score_kind === "not-fetched") {
      continue;
    }
    if (b.sha256 && live.sha256 && b.sha256 !== live.sha256) {
      errors.push(`${b.rel}: sha256 changed (not a score regression — retag/re-fetch)`);
      continue;
    }
    if (b.score_kind === "scorable" && live.score_kind === "unscorable") {
      errors.push(`${b.rel}: scorable → unscorable`);
    }
    if (b.ok && !live.ok) {
      errors.push(`${b.rel}: ok → fail (${(live.error || "").split("\n")[0].slice(0, 80)})`);
      continue;
    }
    const br = VERDICT_RANK[b.verdict];
    const lr = VERDICT_RANK[live.verdict];
    if (br != null && lr != null && lr > br) {
      errors.push(`${b.rel}: verdict ${b.verdict} → ${live.verdict}`);
    }
    if (b.page_match === true && live.page_match === false) {
      errors.push(`${b.rel}: page_match true → false (${live.our_pages} vs ${live.oracle_pages})`);
    }
    if (droppedPct(b.line_exact_pct, live.line_exact_pct)) {
      errors.push(`${b.rel}: line_exact_pct ${b.line_exact_pct} → ${live.line_exact_pct}`);
    }
    if (droppedPct(b.cell_exact_pct, live.cell_exact_pct)) {
      errors.push(`${b.rel}: cell_exact_pct ${b.cell_exact_pct} → ${live.cell_exact_pct}`);
    }
  }
  return errors;
}

function droppedPct(base, live) {
  if (typeof base !== "number" || typeof live !== "number") return false;
  return live + 0.05 < base;
}

export function notFetchedStub(rel, collection, sha256, tags) {
  return {
    rel,
    collection,
    format: rel.endsWith(".hwp") ? "hwp5" : "hwpx",
    ok: false,
    error: "not-fetched (run node scripts/fetch-gov-corpus.mjs)",
    score_kind: "not-fetched",
    verdict: "not-fetched",
    our_pages: 0,
    oracle_pages: 0,
    page_match: null,
    paragraphs: 0,
    body_paragraphs_with_oracle: 0,
    body_paragraphs_missing_oracle: 0,
    line_exact: 0,
    line_within1: 0,
    line_exact_pct: null,
    line_within1_pct: null,
    our_lines: 0,
    oracle_lines: 0,
    cell_paragraphs: 0,
    cell_paragraphs_seen: 0,
    cell_paragraphs_missing_oracle: 0,
    cell_line_exact: 0,
    cell_line_within1: 0,
    cell_exact_pct: null,
    cell_within1_pct: null,
    our_cell_lines: 0,
    oracle_cell_lines: 0,
    cell_structure_mismatches: 0,
    tables: 0,
    table_rows: 0,
    images: 0,
    equations: 0,
    tags: tags || {},
    sha256: sha256 || null,
  };
}

export function joinScore(coverageDoc, cliScore, absMissing) {
  if (absMissing) return notFetchedStub(coverageDoc.rel, coverageDoc.collection, coverageDoc.sha256, coverageDoc.tags);
  if (!cliScore) {
    return {
      ...notFetchedStub(coverageDoc.rel, coverageDoc.collection, coverageDoc.sha256, coverageDoc.tags),
      score_kind: "fail",
      verdict: "fail",
      error: "layout-check --json did not return this path",
    };
  }
  return {
    rel: coverageDoc.rel,
    collection: coverageDoc.collection,
    format: cliScore.format,
    ok: cliScore.ok,
    error: cliScore.error ?? null,
    score_kind: cliScore.score_kind,
    verdict: cliScore.verdict,
    our_pages: cliScore.our_pages,
    oracle_pages: cliScore.oracle_pages,
    page_match: cliScore.page_match ?? null,
    paragraphs: cliScore.paragraphs,
    body_paragraphs_with_oracle: cliScore.body_paragraphs_with_oracle,
    body_paragraphs_missing_oracle: cliScore.body_paragraphs_missing_oracle,
    line_exact: cliScore.line_exact,
    line_within1: cliScore.line_within1,
    line_exact_pct: cliScore.line_exact_pct ?? null,
    line_within1_pct: cliScore.line_within1_pct ?? null,
    our_lines: cliScore.our_lines,
    oracle_lines: cliScore.oracle_lines,
    cell_paragraphs: cliScore.cell_paragraphs,
    cell_paragraphs_seen: cliScore.cell_paragraphs_seen,
    cell_paragraphs_missing_oracle: cliScore.cell_paragraphs_missing_oracle,
    cell_line_exact: cliScore.cell_line_exact,
    cell_line_within1: cliScore.cell_line_within1,
    cell_exact_pct: cliScore.cell_exact_pct ?? null,
    cell_within1_pct: cliScore.cell_within1_pct ?? null,
    our_cell_lines: cliScore.our_cell_lines,
    oracle_cell_lines: cliScore.oracle_cell_lines,
    cell_structure_mismatches: cliScore.cell_structure_mismatches,
    tables: cliScore.tables,
    table_rows: cliScore.table_rows,
    images: cliScore.images,
    equations: cliScore.equations,
    tags: coverageDoc.tags || {},
    sha256: coverageDoc.sha256 || null,
  };
}

export function cliReportsToTsv(reports) {
  const header = [
    "file",
    "verdict",
    "score_kind",
    "our_pages",
    "oracle_pages",
    "page_match",
    "paragraphs",
    "line_exact_pct",
    "cell_paragraphs",
    "cell_exact_pct",
  ].join("\t");
  const lines = [header];
  for (const r of reports) {
    const name = String(r.file || "").split(/[/\\]/).pop();
    lines.push(
      [
        name,
        r.verdict,
        r.score_kind,
        r.our_pages,
        r.oracle_pages,
        r.page_match === true ? "Y" : r.page_match === false ? "N" : "—",
        r.paragraphs,
        r.line_exact_pct == null ? "—" : r.line_exact_pct,
        r.cell_paragraphs,
        r.cell_exact_pct == null ? "—" : r.cell_exact_pct,
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function dash(v) {
  return v == null || v === "" ? "—" : String(v);
}

export function renderMd(doc) {
  const lines = [];
  lines.push("# 조판 오라클 스윕 — 저장 lineseg 회귀 잠금");
  lines.push("");
  lines.push(`> ⚠️ **${DISCLAIMER}**`);
  lines.push(">");
  lines.push("> 변환 .hwpx의 빈 `linesegarray`는 **채점 불가**이지 0점이 아니다.");
  lines.push("");
  lines.push(
    `재현: \`node scripts/oracle-sweep.mjs\` (이슈 #72). 생성 ${doc.generated_at}. CLI: \`auto-hwp layout-check --json\` (features rhwp,shaper). 태그는 \`corpus/typeset-coverage.json\`(#71)과 조인.`,
  );
  lines.push("");
  lines.push("전수 재실행은 **로컬 전용**. CI는 `--check-committed`(요약 정합)만 본다. 기존 게이트 8==8 · 18==18 · 24==24 · 줄바꿈 98.9%+ 는 이 파일과 별개다.");
  lines.push("");
  lines.push("## 요약");
  lines.push("");
  const s = doc.summary;
  lines.push("| 구분 | 건수 |");
  lines.push("|---|---:|");
  lines.push(`| 문서 | ${s.documents} |`);
  lines.push(`| 채점 가능 | ${s.scorable} |`);
  lines.push(`| 채점 불가 (lineseg 없음) | ${s.unscorable} |`);
  lines.push(`| 실패 | ${s.fail} |`);
  lines.push(`| 미반입 (GOV) | ${s.not_fetched} |`);
  lines.push(`| 일치 (쪽수 + 줄 98.9%+) | ${s.match} |`);
  lines.push(`| 줄격차 | ${s.line_gap} |`);
  lines.push(`| 쪽격차 | ${s.page_gap} |`);
  lines.push(`| 본문 줄정확 평균 (채점 가능·본문 오라클만) | ${dash(s.mean_line_exact_pct)}% |`);
  lines.push(`| 셀 줄정확 평균 (채점 가능·셀 오라클만) | ${dash(s.mean_cell_exact_pct)}% |`);
  lines.push("");
  lines.push("## 요소별 점수 (채점 가능 문서만 — 채점 불가를 0으로 넣지 않음)");
  lines.push("");
  lines.push("| 축 | 한국어 | 태깅 | 채점가능 | 채점불가 | 쪽수일치율% | 본문 줄정확% | 셀 줄정확% |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const t of TAGS) {
    const r = doc.by_tag[t];
    lines.push(
      `| \`${t}\` | ${TAG_KO[t]} | ${r.tagged} | ${r.scorable} | ${r.unscorable} | ${dash(r.page_match_rate)} | ${dash(r.mean_line_exact_pct)} | ${dash(r.mean_cell_exact_pct)} |`,
    );
  }
  lines.push("");
  const low = doc.lowest_axes || [];
  if (low.length) {
    lines.push("## 가장 낮은 요소 축 (다음 수리 티켓 근거)");
    lines.push("");
    lines.push("| # | 축 | 채점가능 | 쪽수일치율% | 본문 줄정확% | 셀 줄정확% |");
    lines.push("|---:|---|---:|---:|---:|---:|");
    low.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | \`${r.tag}\` (${TAG_KO[r.tag]}) | ${r.scorable} | ${dash(r.page_match_rate)} | ${dash(r.mean_line_exact_pct)} | ${dash(r.mean_cell_exact_pct)} |`,
      );
    });
    lines.push("");
  }
  lines.push("## 문서별 점수");
  lines.push("");
  lines.push("| 파일 | 수집 | 판정 | 우리쪽 | 한컴쪽 | 본문 줄정확% | 셀 줄정확% | 태그 |");
  lines.push("|---|---|---|---:|---:|---:|---:|---|");
  for (const d of doc.documents) {
    const tags = TAGS.filter((t) => d.tags?.[t]).join(", ") || "—";
    const name = d.rel.replace(/\|/g, "\\|");
    lines.push(
      `| \`${name}\` | ${d.collection} | ${VERDICT_KO[d.verdict] || d.verdict} | ${d.verdict === "unscorable" || d.verdict === "not-fetched" || d.verdict === "fail" ? "—" : d.our_pages} | ${d.verdict === "unscorable" || d.verdict === "not-fetched" || d.verdict === "fail" ? "—" : d.oracle_pages} | ${dash(d.line_exact_pct)} | ${dash(d.cell_exact_pct)} | ${tags} |`,
    );
  }
  lines.push("");
  lines.push("GOV 바이너리는 커밋하지 않는다. 재현: `node scripts/fetch-gov-corpus.mjs`.");
  lines.push("");
  return lines.join("\n");
}

export function validateCommitted(doc) {
  const errors = [];
  if (doc.schema_version !== 1) errors.push("schema_version must be 1");
  if (doc.issue !== 72) errors.push("issue must be 72");
  if (!String(doc.disclaimer || "").includes("참값")) {
    errors.push("disclaimer must say this is not Hangul ground truth");
  }
  if (!Array.isArray(doc.documents) || doc.documents.length === 0) {
    errors.push("documents[] missing");
    return errors;
  }
  const kinds = new Set(["scorable", "unscorable", "fail", "not-fetched"]);
  const verdicts = new Set(["match", "line_gap", "page_gap", "unscorable", "fail", "not-fetched"]);
  for (const d of doc.documents) {
    if (!d.rel) errors.push("document missing rel");
    if (!kinds.has(d.score_kind)) errors.push(`${d.rel}: bad score_kind ${d.score_kind}`);
    if (!verdicts.has(d.verdict)) errors.push(`${d.rel}: bad verdict ${d.verdict}`);
    if (d.score_kind === "unscorable") {
      if (d.line_exact_pct != null || d.cell_exact_pct != null) {
        errors.push(`${d.rel}: unscorable must not carry a percentage score`);
      }
      if (d.page_match != null) {
        errors.push(`${d.rel}: unscorable must not carry page_match`);
      }
    }
    if (d.score_kind === "scorable" && d.line_exact_pct === 0 && d.body_paragraphs_with_oracle === 0 && d.cell_paragraphs === 0) {
      errors.push(`${d.rel}: 0% on a document with no oracle (mixes 0 with unscorable)`);
    }
  }
  const live = summarize(doc.documents);
  for (const k of Object.keys(live)) {
    if (doc.summary?.[k] !== live[k]) {
      errors.push(`summary.${k} ${doc.summary?.[k]} ≠ recomputed ${live[k]}`);
    }
  }
  return errors;
}
