/**
 * Canonical HWP layout gate.
 *
 * The three benchmarks are Hangul-ground-truth gates, not moving regression
 * baselines. Keep these requirements independent from the corpus oracle sweep.
 */

export const CANONICAL_LAYOUT_GATES = Object.freeze({
  "benchmark.hwp": Object.freeze({ pages: 8, bodyOracleMin: 91 }),
  "benchmark1.hwp": Object.freeze({ pages: 18, bodyOracleMin: 257 }),
  "benchmark2.hwp": Object.freeze({ pages: 24, bodyOracleMin: 365 }),
});

export const LINE_EXACT_FLOOR = 98.9;

function canonicalName(file) {
  if (typeof file !== "string") return null;
  const normalized = file.replaceAll("\\", "/");
  const match = normalized.match(/(?:^|\/)benchmarks\/(benchmark(?:1|2)?\.hwp)$/);
  return match?.[1] ?? null;
}
function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Validate parsed `auto-hwp layout-check --json` output.
 *
 * Returns every detected violation so CI explains the complete failure in one
 * run. An empty array means the canonical gate passed.
 */
export function canonicalLayoutGateErrors(reports) {
  if (!Array.isArray(reports)) {
    return ["layout-check JSON root must be an array"];
  }

  const errors = [];
  const byName = new Map();

  for (const [index, report] of reports.entries()) {
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      errors.push(`report[${index}] must be an object`);
      continue;
    }

    const name = canonicalName(report.file);
    if (!name || !Object.hasOwn(CANONICAL_LAYOUT_GATES, name)) {
      errors.push(`report[${index}] unknown benchmark path: ${String(report.file)}`);
      continue;
    }
    if (byName.has(name)) {
      errors.push(`${name}: duplicate report`);
      continue;
    }
    byName.set(name, report);
  }

  for (const [name, requirement] of Object.entries(CANONICAL_LAYOUT_GATES)) {
    const report = byName.get(name);
    if (!report) {
      errors.push(`${name}: missing report`);
      continue;
    }

    if (report.ok !== true) {
      errors.push(`${name}: ok must be true`);
    }
    if (report.score_kind !== "scorable") {
      errors.push(`${name}: score_kind must be scorable (got ${String(report.score_kind)})`);
    }
    if (report.verdict !== "match") {
      errors.push(`${name}: verdict must be match (got ${String(report.verdict)})`);
    }
    if (report.page_match !== true) {
      errors.push(`${name}: page_match must be true`);
    }

    for (const field of ["our_pages", "oracle_pages"]) {
      const value = report[field];
      if (!isInteger(value) || value !== requirement.pages) {
        errors.push(`${name}: ${field} must be exactly ${requirement.pages} (got ${String(value)})`);
      }
    }

    if (typeof report.line_exact_pct !== "number" || !Number.isFinite(report.line_exact_pct)) {
      errors.push(`${name}: line_exact_pct must be a finite number`);
    } else if (report.line_exact_pct < LINE_EXACT_FLOOR) {
      errors.push(
        `${name}: line_exact_pct ${report.line_exact_pct} < ${LINE_EXACT_FLOOR}`,
      );
    }

    const bodyOracle = report.body_paragraphs_with_oracle;
    if (!isInteger(bodyOracle) || bodyOracle < requirement.bodyOracleMin) {
      errors.push(
        `${name}: body_paragraphs_with_oracle must be >= ${requirement.bodyOracleMin} (got ${String(bodyOracle)})`,
      );
    }

    const missingOracle = report.body_paragraphs_missing_oracle;
    if (!isInteger(missingOracle) || missingOracle !== 0) {
      errors.push(
        `${name}: body_paragraphs_missing_oracle must be 0 (got ${String(missingOracle)})`,
      );
    }
  }

  return errors;
}
