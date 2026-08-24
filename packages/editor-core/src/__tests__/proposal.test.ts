import { describe, expect, it } from "vitest";
import { canonicalProposalDigest, type ProposalDigestMaterial } from "../index";

describe("Proposal v1 canonical digest", () => {
  it("matches the Rust/MCP recorded fixture", () => {
    const material: ProposalDigestMaterial = {
      proposal_version: 1,
      session_id: "fixture-session",
      document_id: "fixture-document",
      base_revision: 7,
      intents: [{ block: 2, intent: "SetParagraphText", section: 0, text: "값" }],
      affected_addresses: [{ block: 2, col: null, row: null, section: 0 }],
      affected_pages: [1],
      capabilities: {
        editable: true,
        hwp_export: false,
        hwpx_export: true,
        intent_version: 0,
        pdf_export: true,
      },
      risks: [],
      warnings: [],
      verification: {
        verification_version: 1,
        semantic: { before_hash: "b", after_hash: "a", changed_addresses: [], unchanged_blocks_checked: 1, unexpected_changes: [] },
        before_layout: { pages: 1, lockstep_pages: 1, lines: 1, glyphs: 1, blocks: 1, tables: 0, images: 0 },
        after_layout: { pages: 1, lockstep_pages: 1, lines: 1, glyphs: 1, blocks: 1, tables: 0, images: 0 },
        affected_pages: [1], unaffected_pages_checked: [], page_artifacts: [], pdf: null, structural_failures: [], advisories: [],
        commit_allowed: true, submission_ready: true,
      },
    };
    expect(canonicalProposalDigest(material)).toBe("fnv1a64:1dba1532ae014063");
  });
});
