import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMATS,
  LAYOUT_AXES,
  generatedMarkdownErrors,
  renderCatalogMarkdown,
  summarizeCatalog,
  validateCatalog,
  validateTypesetCoverage,
} from "../lib/gov-source-catalog.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

function makeCoverage() {
  return {
    tag_counts: {
      mixed_orientation: 0,
      footnote: 1,
      multicolumn: 2,
      chart: 1,
      equation: 3,
      form_control: 4,
      nested_table: 10,
      multipage_table: 16,
    },
  };
}

function makeCatalog() {
  const source_families = Array.from({ length: 12 }, (_, index) => ({
    id: `official-family-${index}`,
    name: `공식 출처 ${index}`,
    source_hosts: [`source.family-${index}.go.kr`],
    attachment_hosts: [`files.family-${index}.go.kr`],
    collection_method: ["manual-public-page", "scripted-public-index", "official-open-api"][
      index % 3
    ],
  }));
  const candidates = Array.from({ length: 200 }, (_, index) => {
    const group = Math.floor(index / 2);
    const familyIndex = group % source_families.length;
    const format = FORMATS[(group + (index % 2)) % FORMATS.length];
    const extension = format === "hwp5" ? "hwp" : format;
    return {
      id: `official-family-${familyIndex}:notice-${group}:attachment-${index}`,
      source_family: `official-family-${familyIndex}`,
      source_page: `https://source.family-${familyIndex}.go.kr/notices/${group}`,
      attachment_url: `https://files.family-${familyIndex}.go.kr/attachments/${index}.${extension}?download=1`,
      institution: `공공기관 ${familyIndex}`,
      document_title: `공개 문서 ${group}`,
      attachment_label: `첨부 ${index}.${extension}`,
      format,
      license_basis: {
        code: "KOGL-1",
        verification: "observed",
        evidence_url: `https://source.family-${familyIndex}.go.kr/notices/${group}`,
        observed_at: "2026-08-22",
      },
      collected_at: "2026-08-22T12:00:00+09:00",
      pair_id: `official-family-${familyIndex}:pair-${group}`,
      pair_confidence: "high",
      pair_basis: "same-source-page",
      layout_hints: [
        {
          axis: LAYOUT_AXES[index % LAYOUT_AXES.length],
          confidence: index % 3 === 0 ? "high" : "medium",
          basis: "source-description",
        },
      ],
      privacy_review: {
        classification: index % 2 === 0 ? "official-publication" : "blank-form-template",
        decision: "include",
        reviewed_at: "2026-08-22",
      },
      access_basis: "public-without-controls",
    };
  });
  return {
    schema_version: 1,
    issue: 99,
    catalog_updated_at: "2026-08-22T12:00:00+09:00",
    policy: {
      mode: "metadata-only",
      downloaded_binaries_committed: false,
      privacy_quarantine_public: false,
    },
    source_families,
    screening_summary: {
      rejected_access_control: 3,
      rejected_or_private_quarantine: 2,
      license_review_required: 0,
    },
    candidates,
  };
}

function errorsAfter(mutator) {
  const doc = makeCatalog();
  mutator(doc);
  return validateCatalog(doc);
}

function assertRejected(name, mutator, pattern) {
  test(name, () => {
    const errors = errorsAfter(mutator);
    assert.ok(errors.length > 0, "invalid catalog must fail closed");
    assert.match(errors.join("\n"), pattern);
  });
}

test("accepts a strict synthetic catalog with 200 candidates and 12 used families", () => {
  const doc = makeCatalog();
  assert.deepEqual(validateCatalog(doc), []);
  assert.deepEqual(validateTypesetCoverage(makeCoverage()), []);

  const summary = summarizeCatalog(doc, makeCoverage());
  assert.equal(summary.candidates, 200);
  assert.equal(summary.used_source_families, 12);
  assert.deepEqual(summary.format_counts, { hwp5: 67, hwpx: 67, pdf: 66 });
  assert.equal(summary.layout_axes.length, 8);
  assert.deepEqual(
    new Set(summary.layout_axes.map((entry) => entry.axis)),
    new Set(LAYOUT_AXES),
  );
  assert.equal(summary.layout_axes[0].axis, "mixed_orientation");
});

test("Markdown rendering is deterministic and labels hints as unmeasured", () => {
  const doc = makeCatalog();
  doc.source_families[0].name = "공식 | <script>alert(1)</script>";
  doc.candidates[0].institution = "기관 [링크](https://evil.example)";
  doc.candidates[1].institution = doc.candidates[0].institution;
  const summary = summarizeCatalog(doc, makeCoverage());
  const first = renderCatalogMarkdown(doc, summary);
  const second = renderCatalogMarkdown(structuredClone(doc), structuredClone(summary));
  assert.equal(first, second);
  assert.match(first, /metadata-only/);
  assert.match(first, /추정/);
  assert.match(first, /파일을 열어 `tag-layout`으로 실측한 결과가 아니다/);
  assert.doesNotMatch(first, /<script>/);
  assert.doesNotMatch(first, /\[링크\]\(https:\/\/evil\.example\)/);
  for (const axis of LAYOUT_AXES) assert.match(first, new RegExp(`\\b${axis}\\b`));
});

test("generated Markdown drift fails closed", () => {
  const doc = makeCatalog();
  const coverage = makeCoverage();
  const markdown = renderCatalogMarkdown(doc, summarizeCatalog(doc, coverage));
  assert.deepEqual(generatedMarkdownErrors(doc, coverage, markdown), []);
  assert.match(generatedMarkdownErrors(doc, coverage, `${markdown}\nchanged`).join("\n"), /drifted/);
});

assertRejected(
  "rejects fewer than 200 candidates",
  (doc) => doc.candidates.splice(198),
  /at least 200 entries/,
);

assertRejected(
  "rejects fewer than 12 used source families",
  (doc) => {
    for (const candidate of doc.candidates) {
      if (candidate.source_family !== "official-family-11") continue;
      candidate.source_family = "official-family-0";
      candidate.source_page = candidate.source_page.replace("family-11", "family-0");
      candidate.attachment_url = candidate.attachment_url.replace("family-11", "family-0");
      candidate.license_basis.evidence_url = candidate.license_basis.evidence_url.replace(
        "family-11",
        "family-0",
      );
      candidate.institution = "공공기관 0";
    }
  },
  /at least 12 source families/,
);

assertRejected(
  "rejects family aliases that inflate distinct official source roots",
  (doc) => {
    doc.source_families[1].source_hosts = [...doc.source_families[0].source_hosts];
    doc.source_families[1].attachment_hosts = [...doc.source_families[0].attachment_hosts];
    for (const candidate of doc.candidates) {
      if (candidate.source_family !== "official-family-1") continue;
      candidate.source_page = candidate.source_page.replace("family-1", "family-0");
      candidate.attachment_url = candidate.attachment_url.replace("family-1", "family-0");
      candidate.license_basis.evidence_url = candidate.license_basis.evidence_url.replace(
        "family-1",
        "family-0",
      );
    }
  },
  /aliases the same official site root|distinct official site roots/,
);

assertRejected(
  "requires HWP5, HWPX, and PDF candidates",
  (doc) => {
    for (const candidate of doc.candidates) {
      if (candidate.format === "pdf") candidate.format = "hwp5";
    }
  },
  /must include format pdf/,
);

assertRejected(
  "requires the attachment label extension to match its declared format",
  (doc) => {
    doc.candidates[0].attachment_label = "첨부 0.hwpx";
  },
  /attachment_label extension must match format hwp5/,
);

assertRejected(
  "rejects missing required candidate fields",
  (doc) => delete doc.candidates[0].document_title,
  /document_title is required/,
);

assertRejected(
  "rejects unknown fields including local file paths",
  (doc) => {
    doc.candidates[0].file = "corpus/private/downloaded.hwp";
  },
  /\.file is not allowed/,
);

assertRejected(
  "rejects non-HTTPS source pages",
  (doc) => {
    doc.candidates[0].source_page = doc.candidates[0].source_page.replace("https:", "http:");
  },
  /source_page must use HTTPS/,
);

assertRejected(
  "rejects non-HTTPS attachment URLs",
  (doc) => {
    doc.candidates[0].attachment_url = doc.candidates[0].attachment_url.replace(
      "https:",
      "http:",
    );
  },
  /attachment_url must use HTTPS/,
);

assertRejected(
  "rejects non-HTTPS license evidence URLs",
  (doc) => {
    doc.candidates[0].license_basis.evidence_url =
      doc.candidates[0].license_basis.evidence_url.replace("https:", "http:");
  },
  /evidence_url must use HTTPS/,
);

assertRejected(
  "rejects IPv6 loopback even when declared by a family",
  (doc) => {
    doc.source_families[0].source_hosts = ["[::1]"];
    doc.source_families[0].attachment_hosts = ["[::1]"];
    for (const candidate of doc.candidates) {
      if (candidate.source_family !== "official-family-0") continue;
      candidate.source_page = new URL(candidate.source_page).href.replace(
        "source.family-0.go.kr",
        "[::1]",
      );
      candidate.attachment_url = new URL(candidate.attachment_url).href.replace(
        "files.family-0.go.kr",
        "[::1]",
      );
      candidate.license_basis.evidence_url = new URL(
        candidate.license_basis.evidence_url,
      ).href.replace("source.family-0.go.kr", "[::1]");
    }
  },
  /must be a public hostname/,
);

assertRejected(
  "rejects single-label intranet hosts",
  (doc) => {
    doc.source_families[0].source_hosts = ["intranet"];
  },
  /must be a public hostname/,
);

assertRejected(
  "rejects source hosts outside the family allowlist",
  (doc) => {
    doc.candidates[0].source_page = "https://attacker.example.com/notices/0";
  },
  /source_page hostname .* is not allowlisted/,
);

assertRejected(
  "rejects attachment hosts outside the family allowlist",
  (doc) => {
    doc.candidates[0].attachment_url = "https://attacker.example.com/file.hwp";
  },
  /attachment_url hostname .* is not allowlisted/,
);

assertRejected(
  "rejects license evidence hosts outside the family allowlist",
  (doc) => {
    doc.candidates[0].license_basis.evidence_url = "https://attacker.example.com/license";
  },
  /evidence_url hostname .* is not allowlisted/,
);

assertRejected(
  "rejects duplicate candidate ids",
  (doc) => {
    doc.candidates[1].id = doc.candidates[0].id;
  },
  /id duplicates/,
);

assertRejected(
  "rejects duplicate attachment URLs",
  (doc) => {
    doc.candidates[1].attachment_url = doc.candidates[0].attachment_url;
  },
  /attachment_url duplicates/,
);

assertRejected(
  "normalizes query order when detecting duplicate attachment identities",
  (doc) => {
    doc.candidates[0].attachment_url =
      "https://files.family-0.go.kr/attachments/same?file=1&sequence=2";
    doc.candidates[1].attachment_url =
      "https://files.family-0.go.kr/attachments/same?sequence=2&file=1";
  },
  /attachment_url duplicates/,
);

assertRejected(
  "rejects an orphan pair",
  (doc) => {
    doc.candidates[1].pair_id = null;
    doc.candidates[1].pair_confidence = null;
    doc.candidates[1].pair_basis = null;
  },
  /pair .* must contain at least two candidates/,
);

assertRejected(
  "rejects a pair that contains only one format",
  (doc) => {
    doc.candidates[1].format = doc.candidates[0].format;
  },
  /pair .* must contain at least two distinct formats/,
);

assertRejected(
  "rejects inconsistent pair evidence",
  (doc) => {
    doc.candidates[1].pair_basis = "same-title-cross-page";
  },
  /pair .* has inconsistent pair_basis/,
);

assertRejected(
  "rejects pair members from different source pages",
  (doc) => {
    doc.candidates[1].source_page = "https://source.family-0.go.kr/notices/other";
  },
  /pair .* has inconsistent source_page/,
);

assertRejected(
  "rejects pair metadata when pair_id is null",
  (doc) => {
    doc.candidates[0].pair_id = null;
  },
  /pair_confidence and pair_basis must be null/,
);

for (const forbidden of ["completed-record", "possible-pii", "quarantine"]) {
  assertRejected(
    `rejects public privacy classification ${forbidden}`,
    (doc) => {
      doc.candidates[0].privacy_review.classification = forbidden;
    },
    /forbidden in the public catalog/,
  );
}

assertRejected(
  "rejects a quarantine decision in the public catalog",
  (doc) => {
    doc.candidates[0].privacy_review.decision = "quarantine";
  },
  /forbidden in the public catalog/,
);

assertRejected(
  "rejects candidates behind access controls",
  (doc) => {
    doc.candidates[0].access_basis = "login-required";
  },
  /access_basis must be "public-without-controls"/,
);

assertRejected(
  "rejects metadata that signals completed records or possible PII",
  (doc) => {
    doc.candidates[0].attachment_label = "지원자 명단 제출본.hwp";
  },
  /completed-record or possible-PII risk metadata/,
);

assertRejected(
  "rejects URLs that point at an access-control flow",
  (doc) => {
    doc.candidates[0].source_page = "https://source.family-0.go.kr/login/notices/0";
  },
  /URL indicates login, CAPTCHA, or access-control flow/,
);

assertRejected(
  "rejects access-control endpoints with a common executable suffix",
  (doc) => {
    doc.candidates[0].source_page = "https://source.family-0.go.kr/login.do";
  },
  /URL indicates login, CAPTCHA, or access-control flow/,
);

assertRejected(
  "requires metadata-only policy",
  (doc) => {
    doc.policy.mode = "download";
  },
  /policy.mode must be "metadata-only"/,
);

assertRejected(
  "forbids committed downloaded binaries",
  (doc) => {
    doc.policy.downloaded_binaries_committed = true;
  },
  /downloaded_binaries_committed must be false/,
);

assertRejected(
  "forbids public quarantine metadata",
  (doc) => {
    doc.policy.privacy_quarantine_public = true;
  },
  /privacy_quarantine_public must be false/,
);

assertRejected(
  "rejects unknown layout axes",
  (doc) => {
    doc.candidates[0].layout_hints[0].axis = "header_footer";
  },
  /layout_hints\[0\]\.axis must be one of/,
);

assertRejected(
  "requires candidate evidence for every ranked layout axis",
  (doc) => {
    for (const candidate of doc.candidates) candidate.layout_hints = [];
  },
  /must include a layout hint for mixed_orientation/,
);

assertRejected(
  "rejects invalid collection timestamps",
  (doc) => {
    doc.candidates[0].collected_at = "2026-08-22";
  },
  /must be a valid RFC 3339 timestamp/,
);

assertRejected(
  "rejects normalized but impossible RFC 3339 calendar dates",
  (doc) => {
    doc.candidates[0].collected_at = "2026-02-31T12:00:00Z";
  },
  /valid calendar, time, and timezone components/,
);

assertRejected(
  "requires screening counts to match license review metadata",
  (doc) => {
    doc.candidates[0].license_basis.verification = "review-required";
  },
  /license_review_required must equal review-required candidates/,
);

test("coverage summary requires all eight layout axes", () => {
  const coverage = makeCoverage();
  delete coverage.tag_counts.chart;
  assert.match(validateTypesetCoverage(coverage).join("\n"), /tag_counts\.chart/);
});

test("the catalog CLI and imported library contain no downloader or subprocess dependency", () => {
  const source = [
    readFileSync(join(repo, "scripts", "gov-source-catalog.mjs"), "utf8"),
    readFileSync(join(repo, "scripts", "lib", "gov-source-catalog.mjs"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(
    source,
    /node:(?:http|https|http2|child_process)|\b(?:undici|axios)\b|\bfetch\s*\(/,
  );
});
