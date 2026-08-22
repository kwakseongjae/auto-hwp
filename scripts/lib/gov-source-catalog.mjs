import { isIP } from "node:net";

/**
 * Public, metadata-only government source catalog contract (issue #99).
 *
 * This module is intentionally pure: it validates already-collected metadata,
 * summarizes it, and renders Markdown. It never fetches an attachment URL.
 */

export const CATALOG_SCHEMA_VERSION = 1;
export const REQUIRED_CANDIDATES = 200;
export const REQUIRED_USED_SOURCE_FAMILIES = 12;
export const FORMATS = Object.freeze(["hwp5", "hwpx", "pdf"]);
const FORMAT_LABEL_SUFFIX = Object.freeze({ hwp5: ".hwp", hwpx: ".hwpx", pdf: ".pdf" });
export const LAYOUT_AXES = Object.freeze([
  "mixed_orientation",
  "footnote",
  "multicolumn",
  "chart",
  "equation",
  "form_control",
  "nested_table",
  "multipage_table",
]);

const AXIS_KO = Object.freeze({
  mixed_orientation: "가로·세로 혼합",
  footnote: "각주",
  multicolumn: "다단",
  chart: "차트",
  equation: "수식",
  form_control: "폼 컨트롤",
  nested_table: "중첩 표",
  multipage_table: "다쪽 표",
});

const COLLECTION_METHODS = new Set([
  "manual-public-page",
  "scripted-public-index",
  "official-open-api",
]);
const LICENSE_VERIFICATIONS = new Set(["observed", "review-required"]);
const PAIR_CONFIDENCES = new Set(["low", "medium", "high"]);
const HINT_CONFIDENCES = new Set(["low", "medium", "high"]);
const PUBLIC_CLASSIFICATIONS = new Set([
  "official-publication",
  "blank-form-template",
  "public-guidance",
]);
const FORBIDDEN_PUBLIC_PRIVACY_VALUES = new Set([
  "completed-record",
  "possible-pii",
  "quarantine",
]);
const PUBLIC_METADATA_DENY_PATTERN =
  /(?:합격자|명단|후보자|공개검증|작성본|제출본|신청완료|서명|날인|주민등록|계좌번호|completed[ _-]*(?:record|form)|submitted[ _-]*(?:record|form)|signed[ _-]*copy|(?:applicant|candidate)[ _-]*list)/iu;
const ACCESS_CONTROL_SEGMENTS = new Set(["login", "signin", "captcha", "auth", "oauth"]);
const ACCESS_CONTROL_EXECUTABLE_SUFFIX = /\.(?:do|jsp|jspx|html?|php|aspx?)$/u;

const TOP_LEVEL_KEYS = [
  "schema_version",
  "issue",
  "catalog_updated_at",
  "policy",
  "source_families",
  "screening_summary",
  "candidates",
];
const POLICY_KEYS = [
  "mode",
  "downloaded_binaries_committed",
  "privacy_quarantine_public",
];
const FAMILY_KEYS = [
  "id",
  "name",
  "source_hosts",
  "attachment_hosts",
  "collection_method",
];
const SCREENING_KEYS = [
  "rejected_access_control",
  "rejected_or_private_quarantine",
  "license_review_required",
];
const CANDIDATE_KEYS = [
  "id",
  "source_family",
  "source_page",
  "attachment_url",
  "institution",
  "document_title",
  "attachment_label",
  "format",
  "license_basis",
  "collected_at",
  "pair_id",
  "pair_confidence",
  "pair_basis",
  "layout_hints",
  "privacy_review",
  "access_basis",
];
const LICENSE_KEYS = ["code", "verification", "evidence_url", "observed_at"];
const HINT_KEYS = ["axis", "confidence", "basis"];
const PRIVACY_KEYS = ["classification", "decision", "reviewed_at"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkExactKeys(value, allowed, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  return true;
}

function checkString(value, path, errors, { max = 1000, pattern } = {}) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    errors.push(`${path} must be a non-empty trimmed string`);
    return false;
  }
  if (value.length > max) {
    errors.push(`${path} must be at most ${max} characters`);
    return false;
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    errors.push(`${path} must not contain control characters`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${path} has an invalid format`);
    return false;
  }
  return true;
}

function checkInteger(value, path, errors) {
  if (!Number.isSafeInteger(value) || value < 0) {
    errors.push(`${path} must be a non-negative safe integer`);
    return false;
  }
  return true;
}

function checkDate(value, path, errors) {
  if (!checkString(value, path, errors, { max: 10 })) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${path} must be an ISO 8601 calendar date (YYYY-MM-DD)`);
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    errors.push(`${path} is not a valid calendar date`);
    return false;
  }
  return true;
}

function checkRfc3339(value, path, errors) {
  if (!checkString(value, path, errors, { max: 40 })) return false;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) {
    errors.push(`${path} must be a valid RFC 3339 timestamp with timezone`);
    return false;
  }
  const componentErrors = [];
  checkDate(match[1], `${path} date`, componentErrors);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
  const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
  if (
    componentErrors.length ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    errors.push(`${path} must contain valid calendar, time, and timezone components`);
    return false;
  }
  return true;
}

function checkHost(value, path, errors) {
  if (!checkString(value, path, errors, { max: 253 })) return false;
  if (value !== value.toLowerCase() || value.endsWith(".") || value.includes("*")) {
    errors.push(`${path} must be a lowercase exact hostname without wildcards`);
    return false;
  }
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const labels = value.split(".");
  if (
    labels.length < 2 ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value.endsWith(".test") ||
    value.endsWith(".example") ||
    value.endsWith(".invalid") ||
    isIP(unbracketed) !== 0
  ) {
    errors.push(`${path} must be a public hostname`);
    return false;
  }
  try {
    const parsed = new URL(`https://${value}`);
    if (parsed.hostname !== value || parsed.port !== "") throw new Error("not exact");
  } catch {
    errors.push(`${path} must be a valid hostname`);
    return false;
  }
  return true;
}

function siteRoot(host) {
  const labels = host.split(".");
  const koreanSecondLevel = new Set(["go.kr", "or.kr", "ac.kr", "co.kr", "ne.kr", "re.kr"]);
  const suffix = labels.slice(-2).join(".");
  const take = koreanSecondLevel.has(suffix) ? 3 : 2;
  return labels.slice(-take).join(".");
}

function checkHostList(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty hostname array`);
    return [];
  }
  const hosts = [];
  const seen = new Set();
  value.forEach((host, index) => {
    if (!checkHost(host, `${path}[${index}]`, errors)) return;
    if (seen.has(host)) errors.push(`${path}[${index}] duplicates hostname ${host}`);
    seen.add(host);
    hosts.push(host);
  });
  return hosts;
}

function checkHttpsUrl(value, path, errors, allowedHosts = null) {
  if (!checkString(value, path, errors, { max: 4096 })) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${path} must be an absolute URL`);
    return null;
  }
  if (parsed.protocol !== "https:") errors.push(`${path} must use HTTPS`);
  if (parsed.username || parsed.password) errors.push(`${path} must not contain credentials`);
  if (parsed.port) errors.push(`${path} must not use a non-default explicit port`);
  if (!checkHost(parsed.hostname, `${path} hostname`, errors)) return null;
  if (allowedHosts && !allowedHosts.has(parsed.hostname)) {
    errors.push(`${path} hostname ${parsed.hostname} is not allowlisted by its source family`);
  }
  return parsed;
}

function checkEnum(value, values, path, errors) {
  if (!values.has(value)) {
    errors.push(`${path} must be one of: ${[...values].join(", ")}`);
    return false;
  }
  return true;
}

function canonicalAttachmentUrl(parsed) {
  if (!parsed) return null;
  const copy = new URL(parsed.href);
  copy.hash = "";
  copy.searchParams.sort();
  return copy.href;
}

function decodedUrlMetadata(parsed) {
  if (!parsed) return "";
  const value = `${parsed.pathname} ${parsed.search}`;
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function hasAccessControlIndicator(parsed) {
  if (!parsed) return false;
  const normalizeToken = (value) => {
    let decoded = value.toLowerCase();
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Invalid escapes are handled by URL parsing; keep the raw token for a safe exact check.
    }
    return decoded.replace(ACCESS_CONTROL_EXECUTABLE_SUFFIX, "");
  };
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map(normalizeToken);
  if (segments.some((segment) => ACCESS_CONTROL_SEGMENTS.has(segment))) return true;
  return [...parsed.searchParams.keys()].some((key) =>
    ACCESS_CONTROL_SEGMENTS.has(normalizeToken(key)),
  );
}

function pushCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedCountObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => compareText(a, b)));
}

export function validateTypesetCoverage(coverage) {
  const errors = [];
  if (!isPlainObject(coverage)) return ["typeset coverage must be an object"];
  if (!isPlainObject(coverage.tag_counts)) {
    return ["typeset coverage.tag_counts must be an object"];
  }
  for (const axis of LAYOUT_AXES) {
    checkInteger(coverage.tag_counts[axis], `typeset coverage.tag_counts.${axis}`, errors);
  }
  return errors;
}

export function validateCatalog(doc) {
  const errors = [];
  if (!checkExactKeys(doc, TOP_LEVEL_KEYS, "catalog", errors)) return errors;

  if (doc.schema_version !== CATALOG_SCHEMA_VERSION) {
    errors.push(`catalog.schema_version must be ${CATALOG_SCHEMA_VERSION}`);
  }
  if (doc.issue !== 99) errors.push("catalog.issue must be 99");
  checkRfc3339(doc.catalog_updated_at, "catalog.catalog_updated_at", errors);

  if (checkExactKeys(doc.policy, POLICY_KEYS, "catalog.policy", errors)) {
    if (doc.policy.mode !== "metadata-only") {
      errors.push('catalog.policy.mode must be "metadata-only"');
    }
    if (doc.policy.downloaded_binaries_committed !== false) {
      errors.push("catalog.policy.downloaded_binaries_committed must be false");
    }
    if (doc.policy.privacy_quarantine_public !== false) {
      errors.push("catalog.policy.privacy_quarantine_public must be false");
    }
  }

  if (checkExactKeys(doc.screening_summary, SCREENING_KEYS, "catalog.screening_summary", errors)) {
    for (const key of SCREENING_KEYS) {
      checkInteger(doc.screening_summary[key], `catalog.screening_summary.${key}`, errors);
    }
  }

  const families = new Map();
  const familyEndpointOwners = new Map();
  if (!Array.isArray(doc.source_families)) {
    errors.push("catalog.source_families must be an array");
  } else {
    doc.source_families.forEach((family, index) => {
      const path = `catalog.source_families[${index}]`;
      if (!checkExactKeys(family, FAMILY_KEYS, path, errors)) return;
      const idOk = checkString(family.id, `${path}.id`, errors, {
        max: 80,
        pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      });
      checkString(family.name, `${path}.name`, errors, { max: 200 });
      const sourceHosts = checkHostList(family.source_hosts, `${path}.source_hosts`, errors);
      const attachmentHosts = checkHostList(
        family.attachment_hosts,
        `${path}.attachment_hosts`,
        errors,
      );
      checkEnum(family.collection_method, COLLECTION_METHODS, `${path}.collection_method`, errors);
      if (idOk) {
        if (families.has(family.id)) errors.push(`${path}.id duplicates ${family.id}`);
        else {
          const endpointIdentity = [
            ...new Set([...sourceHosts, ...attachmentHosts].map(siteRoot)),
          ]
            .sort(compareText)
            .join(",");
          const existingOwner = familyEndpointOwners.get(endpointIdentity);
          if (endpointIdentity && existingOwner) {
            errors.push(
              `${path} aliases the same official site root(s) as source family ${existingOwner}`,
            );
          } else if (endpointIdentity) {
            familyEndpointOwners.set(endpointIdentity, family.id);
          }
          families.set(family.id, {
            family,
            sourceHosts: new Set(sourceHosts),
            attachmentHosts: new Set(attachmentHosts),
            endpointIdentity,
          });
        }
      }
    });
  }

  if (!Array.isArray(doc.candidates)) {
    errors.push("catalog.candidates must be an array");
    return errors;
  }
  if (doc.candidates.length < REQUIRED_CANDIDATES) {
    errors.push(
      `catalog.candidates must contain at least ${REQUIRED_CANDIDATES} entries (got ${doc.candidates.length})`,
    );
  }

  const ids = new Set();
  const attachmentUrls = new Set();
  const usedFamilies = new Set();
  const usedFamilyEndpointIdentities = new Set();
  const formats = new Set();
  const pairs = new Map();
  const hintedCatalogAxes = new Set();
  let reviewRequired = 0;

  doc.candidates.forEach((candidate, index) => {
    const path = `catalog.candidates[${index}]`;
    if (!checkExactKeys(candidate, CANDIDATE_KEYS, path, errors)) return;

    if (checkString(candidate.id, `${path}.id`, errors, { max: 240 })) {
      if (ids.has(candidate.id)) errors.push(`${path}.id duplicates ${candidate.id}`);
      ids.add(candidate.id);
    }

    let familyEntry = null;
    if (checkString(candidate.source_family, `${path}.source_family`, errors, { max: 80 })) {
      familyEntry = families.get(candidate.source_family) || null;
      if (!familyEntry) errors.push(`${path}.source_family is not declared`);
      else {
        usedFamilies.add(candidate.source_family);
        usedFamilyEndpointIdentities.add(familyEntry.endpointIdentity);
      }
    }

    const sourcePage = checkHttpsUrl(
      candidate.source_page,
      `${path}.source_page`,
      errors,
      familyEntry?.sourceHosts,
    );
    const attachment = checkHttpsUrl(
      candidate.attachment_url,
      `${path}.attachment_url`,
      errors,
      familyEntry?.attachmentHosts,
    );
    if (sourcePage?.hash) errors.push(`${path}.source_page must not contain a URL fragment`);
    if (attachment?.hash) errors.push(`${path}.attachment_url must not contain a URL fragment`);
    const canonicalUrl = canonicalAttachmentUrl(attachment);
    if (canonicalUrl) {
      if (attachmentUrls.has(canonicalUrl)) {
        errors.push(`${path}.attachment_url duplicates ${canonicalUrl}`);
      }
      attachmentUrls.add(canonicalUrl);
    }

    checkString(candidate.institution, `${path}.institution`, errors, { max: 300 });
    checkString(candidate.document_title, `${path}.document_title`, errors, { max: 1000 });
    const labelValid = checkString(
      candidate.attachment_label,
      `${path}.attachment_label`,
      errors,
      { max: 1000 },
    );
    const formatValid = checkEnum(candidate.format, new Set(FORMATS), `${path}.format`, errors);
    if (formatValid) {
      formats.add(candidate.format);
    }
    if (
      labelValid &&
      formatValid &&
      !candidate.attachment_label.toLowerCase().endsWith(FORMAT_LABEL_SUFFIX[candidate.format])
    ) {
      errors.push(`${path}.attachment_label extension must match format ${candidate.format}`);
    }
    checkRfc3339(candidate.collected_at, `${path}.collected_at`, errors);
    if (candidate.access_basis !== "public-without-controls") {
      errors.push(`${path}.access_basis must be "public-without-controls"`);
    }

    if (checkExactKeys(candidate.license_basis, LICENSE_KEYS, `${path}.license_basis`, errors)) {
      checkString(candidate.license_basis.code, `${path}.license_basis.code`, errors, { max: 120 });
      if (
        checkEnum(
          candidate.license_basis.verification,
          LICENSE_VERIFICATIONS,
          `${path}.license_basis.verification`,
          errors,
        ) &&
        candidate.license_basis.verification === "review-required"
      ) {
        reviewRequired += 1;
      }
      const evidenceHosts = familyEntry
        ? new Set([...familyEntry.sourceHosts, ...familyEntry.attachmentHosts])
        : null;
      const evidenceUrl = checkHttpsUrl(
        candidate.license_basis.evidence_url,
        `${path}.license_basis.evidence_url`,
        errors,
        evidenceHosts,
      );
      if (hasAccessControlIndicator(evidenceUrl)) {
        errors.push(`${path}.license_basis.evidence_url indicates an access-control flow`);
      }
      checkDate(candidate.license_basis.observed_at, `${path}.license_basis.observed_at`, errors);
    }

    if (!Array.isArray(candidate.layout_hints)) {
      errors.push(`${path}.layout_hints must be an array`);
    } else {
      const hintedAxes = new Set();
      candidate.layout_hints.forEach((hint, hintIndex) => {
        const hintPath = `${path}.layout_hints[${hintIndex}]`;
        if (!checkExactKeys(hint, HINT_KEYS, hintPath, errors)) return;
        if (checkEnum(hint.axis, new Set(LAYOUT_AXES), `${hintPath}.axis`, errors)) {
          if (hintedAxes.has(hint.axis)) errors.push(`${hintPath}.axis duplicates ${hint.axis}`);
          hintedAxes.add(hint.axis);
          hintedCatalogAxes.add(hint.axis);
        }
        checkEnum(hint.confidence, HINT_CONFIDENCES, `${hintPath}.confidence`, errors);
        checkString(hint.basis, `${hintPath}.basis`, errors, { max: 500 });
      });
    }

    const publicMetadata = [
      candidate.document_title,
      candidate.attachment_label,
      decodedUrlMetadata(sourcePage),
      decodedUrlMetadata(attachment),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    if (PUBLIC_METADATA_DENY_PATTERN.test(publicMetadata)) {
      errors.push(`${path} contains completed-record or possible-PII risk metadata`);
    }
    if (hasAccessControlIndicator(sourcePage) || hasAccessControlIndicator(attachment)) {
      errors.push(`${path} URL indicates login, CAPTCHA, or access-control flow`);
    }

    if (checkExactKeys(candidate.privacy_review, PRIVACY_KEYS, `${path}.privacy_review`, errors)) {
      if (FORBIDDEN_PUBLIC_PRIVACY_VALUES.has(candidate.privacy_review.classification)) {
        errors.push(`${path}.privacy_review.classification is forbidden in the public catalog`);
      } else {
        checkEnum(
          candidate.privacy_review.classification,
          PUBLIC_CLASSIFICATIONS,
          `${path}.privacy_review.classification`,
          errors,
        );
      }
      if (FORBIDDEN_PUBLIC_PRIVACY_VALUES.has(candidate.privacy_review.decision)) {
        errors.push(`${path}.privacy_review.decision is forbidden in the public catalog`);
      } else if (candidate.privacy_review.decision !== "include") {
        errors.push(`${path}.privacy_review.decision must be "include"`);
      }
      checkDate(candidate.privacy_review.reviewed_at, `${path}.privacy_review.reviewed_at`, errors);
    }

    const pairFields = [candidate.pair_confidence, candidate.pair_basis];
    if (candidate.pair_id === null) {
      if (pairFields.some((value) => value !== null)) {
        errors.push(`${path}: pair_confidence and pair_basis must be null when pair_id is null`);
      }
    } else if (checkString(candidate.pair_id, `${path}.pair_id`, errors, { max: 240 })) {
      checkEnum(candidate.pair_confidence, PAIR_CONFIDENCES, `${path}.pair_confidence`, errors);
      checkString(candidate.pair_basis, `${path}.pair_basis`, errors, { max: 500 });
      const members = pairs.get(candidate.pair_id) || [];
      members.push({ candidate, path });
      pairs.set(candidate.pair_id, members);
    }
  });

  if (usedFamilies.size < REQUIRED_USED_SOURCE_FAMILIES) {
    errors.push(
      `catalog must use at least ${REQUIRED_USED_SOURCE_FAMILIES} source families (got ${usedFamilies.size})`,
    );
  }
  if (usedFamilyEndpointIdentities.size < REQUIRED_USED_SOURCE_FAMILIES) {
    errors.push(
      `catalog must use at least ${REQUIRED_USED_SOURCE_FAMILIES} distinct official site roots (got ${usedFamilyEndpointIdentities.size})`,
    );
  }
  for (const format of FORMATS) {
    if (!formats.has(format)) errors.push(`catalog must include format ${format}`);
  }
  for (const axis of LAYOUT_AXES) {
    if (!hintedCatalogAxes.has(axis)) errors.push(`catalog must include a layout hint for ${axis}`);
  }
  if (
    isPlainObject(doc.screening_summary) &&
    Number.isSafeInteger(doc.screening_summary.license_review_required) &&
    doc.screening_summary.license_review_required !== reviewRequired
  ) {
    errors.push(
      `catalog.screening_summary.license_review_required must equal review-required candidates (${reviewRequired})`,
    );
  }

  for (const [pairId, members] of pairs) {
    if (members.length < 2) {
      errors.push(`pair ${pairId} must contain at least two candidates`);
      continue;
    }
    const pairFormats = new Set(members.map(({ candidate }) => candidate.format));
    if (pairFormats.size < 2) errors.push(`pair ${pairId} must contain at least two distinct formats`);
    const [first] = members;
    for (const member of members.slice(1)) {
      for (const key of [
        "pair_confidence",
        "pair_basis",
        "source_family",
        "institution",
        "source_page",
        "document_title",
      ]) {
        if (member.candidate[key] !== first.candidate[key]) {
          errors.push(`pair ${pairId} has inconsistent ${key}`);
          break;
        }
      }
    }
  }

  return errors;
}

function assertValid(doc, coverage) {
  const errors = [
    ...validateCatalog(doc),
    ...validateTypesetCoverage(coverage),
  ];
  if (errors.length) throw new Error(`invalid public source catalog:\n- ${errors.join("\n- ")}`);
}

export function summarizeCatalog(doc, typesetCoverage) {
  assertValid(doc, typesetCoverage);

  const familyCounts = new Map();
  const institutionCounts = new Map();
  const licenseCounts = new Map();
  const formatCounts = new Map(FORMATS.map((format) => [format, 0]));
  const hintCounts = new Map(LAYOUT_AXES.map((axis) => [axis, 0]));
  const highHintCounts = new Map(LAYOUT_AXES.map((axis) => [axis, 0]));
  const pairs = new Map();

  for (const candidate of doc.candidates) {
    pushCount(familyCounts, candidate.source_family);
    pushCount(institutionCounts, candidate.institution);
    pushCount(formatCounts, candidate.format);
    pushCount(
      licenseCounts,
      `${candidate.license_basis.code} / ${candidate.license_basis.verification}`,
    );
    for (const hint of candidate.layout_hints) {
      pushCount(hintCounts, hint.axis);
      if (hint.confidence === "high") pushCount(highHintCounts, hint.axis);
    }
    if (candidate.pair_id !== null) {
      const formatsForPair = pairs.get(candidate.pair_id) || new Set();
      formatsForPair.add(candidate.format);
      pairs.set(candidate.pair_id, formatsForPair);
    }
  }

  const axisOrder = new Map(LAYOUT_AXES.map((axis, index) => [axis, index]));
  const layoutAxes = LAYOUT_AXES.map((axis) => ({
    axis,
    measured_documents: typesetCoverage.tag_counts[axis],
    candidate_hints: hintCounts.get(axis),
    high_confidence_hints: highHintCounts.get(axis),
  }))
    .sort((a, b) => {
      if (a.measured_documents !== b.measured_documents) {
        return a.measured_documents - b.measured_documents;
      }
      if (a.candidate_hints !== b.candidate_hints) return b.candidate_hints - a.candidate_hints;
      return axisOrder.get(a.axis) - axisOrder.get(b.axis);
    })
    .map((entry, index) => ({ priority: index + 1, ...entry }));

  const familyById = new Map(doc.source_families.map((family) => [family.id, family]));
  const sourceFamilies = [...familyCounts.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([id, candidates]) => ({ id, name: familyById.get(id).name, candidates }));

  return {
    candidates: doc.candidates.length,
    used_source_families: familyCounts.size,
    source_family_counts: sourceFamilies,
    institution_counts: sortedCountObject(institutionCounts),
    format_counts: sortedCountObject(formatCounts),
    license_counts: sortedCountObject(licenseCounts),
    pair_summary: {
      groups: pairs.size,
      candidates: doc.candidates.filter((candidate) => candidate.pair_id !== null).length,
      three_format_groups: [...pairs.values()].filter((pairFormats) => pairFormats.size === 3).length,
      unpaired_candidates: doc.candidates.filter((candidate) => candidate.pair_id === null).length,
    },
    screening_summary: { ...doc.screening_summary },
    layout_axes: layoutAxes,
  };
}

function escapeCell(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\|`*_[\]()])/g, "\\$1");
}

export function renderCatalogMarkdown(doc, summary) {
  const lines = [];
  lines.push("# 공공 HWP/HWPX/PDF 후보 출처 카탈로그");
  lines.push("");
  lines.push(
    "> ⚠️ 이 문서는 **metadata-only 후보 목록의 요약**이다. 첨부 URL은 비활성 메타데이터이며 이 명령은 다운로드·실행·파싱하지 않는다.",
  );
  lines.push(
    "> 작성 완료 문서·개인정보 가능 항목·격리 항목의 제목과 URL은 공개하지 않는다. 제외 건수만 집계한다.",
  );
  lines.push("");
  lines.push(
    `정본: \`corpus/gov-source-catalog.json\` · 스키마 ${doc.schema_version} · 이슈 #${doc.issue} · 갱신 ${doc.catalog_updated_at}`,
  );
  lines.push("");
  lines.push("후보의 `layout_hints`는 출처 설명·첨부명에서 얻은 **추정**이며, 파일을 열어 `tag-layout`으로 실측한 결과가 아니다.");
  lines.push("");
  lines.push("## 수집 요약");
  lines.push("");
  lines.push("| 항목 | 건수 |");
  lines.push("|---|---:|");
  lines.push(`| 후보 첨부 | ${summary.candidates} |`);
  lines.push(`| 실제 사용 출처 family | ${summary.used_source_families} |`);
  for (const format of FORMATS) {
    lines.push(`| \`${format}\` | ${summary.format_counts[format]} |`);
  }
  lines.push(`| pair 그룹 | ${summary.pair_summary.groups} |`);
  lines.push(`| 3형식 pair 그룹 | ${summary.pair_summary.three_format_groups} |`);
  lines.push(`| pair 미지정 후보 | ${summary.pair_summary.unpaired_candidates} |`);
  lines.push("");
  lines.push("## 공개 제외·검토 집계");
  lines.push("");
  lines.push("| 사유 | 건수 | 공개 범위 |");
  lines.push("|---|---:|---|");
  lines.push(
    `| 로그인·CAPTCHA·robots·접근통제 | ${summary.screening_summary.rejected_access_control} | 건수만 |`,
  );
  lines.push(
    `| 개인정보 가능·비공개 격리 | ${summary.screening_summary.rejected_or_private_quarantine} | 건수만 |`,
  );
  lines.push(
    `| 라이선스 추가 검토 | ${summary.screening_summary.license_review_required} | 후보 메타데이터만 |`,
  );
  lines.push("");
  lines.push("## 조판 커버리지 빈칸 우선순위");
  lines.push("");
  lines.push("기존 실측 문서 수가 적은 축을 먼저 두고, 동률이면 후보 힌트가 많은 축을 앞세운다.");
  lines.push("");
  lines.push("| 우선 | 축 | 기존 실측 | 후보 힌트 | 고신뢰 힌트 |");
  lines.push("|---:|---|---:|---:|---:|");
  for (const axis of summary.layout_axes) {
    lines.push(
      `| ${axis.priority} | \`${axis.axis}\` (${AXIS_KO[axis.axis]}) | ${axis.measured_documents} | ${axis.candidate_hints} | ${axis.high_confidence_hints} |`,
    );
  }
  lines.push("");
  lines.push("## 출처 family");
  lines.push("");
  lines.push("| ID | 출처 | 후보 |");
  lines.push("|---|---|---:|");
  for (const family of summary.source_family_counts) {
    lines.push(
      `| \`${escapeCell(family.id)}\` | ${escapeCell(family.name)} | ${family.candidates} |`,
    );
  }
  lines.push("");
  lines.push("## 기관별 후보");
  lines.push("");
  lines.push("| 기관 | 후보 |");
  lines.push("|---|---:|");
  for (const [institution, count] of Object.entries(summary.institution_counts)) {
    lines.push(`| ${escapeCell(institution)} | ${count} |`);
  }
  lines.push("");
  lines.push("## 관찰된 라이선스 근거");
  lines.push("");
  lines.push("| 코드 / 확인 상태 | 후보 |");
  lines.push("|---|---:|");
  for (const [license, count] of Object.entries(summary.license_counts)) {
    lines.push(`| ${escapeCell(license)} | ${count} |`);
  }
  lines.push("");
  lines.push("## #100 승격 경계");
  lines.push("");
  lines.push(
    "이 카탈로그의 후보는 다운로드 대상이 아니다. 후속 #100에서 라이선스·개인정보·접근통제·매직바이트·SHA-256을 다시 검증한 항목만 `corpus/gov-sources.json`으로 승격한다.",
  );
  lines.push(
    "독립 재확인은 JSON의 `source_page`, `attachment_url`, `institution`, `attachment_label`, `collected_at`, `license_basis`를 사용한다. 바이너리는 계속 `corpus/private/`에만 둔다.",
  );
  lines.push("");
  lines.push("재현: `node scripts/gov-source-catalog.mjs --check` · 요약 갱신: `node scripts/gov-source-catalog.mjs --write`.");
  lines.push("");
  return lines.join("\n");
}

export function generatedMarkdownErrors(doc, typesetCoverage, committedMarkdown) {
  const errors = [...validateCatalog(doc), ...validateTypesetCoverage(typesetCoverage)];
  if (errors.length) return errors;
  const summary = summarizeCatalog(doc, typesetCoverage);
  const expected = renderCatalogMarkdown(doc, summary);
  if (committedMarkdown !== expected) {
    errors.push(
      "corpus/GOV-SOURCE-CATALOG.md drifted from gov-source-catalog.json and typeset-coverage.json",
    );
  }
  return errors;
}
