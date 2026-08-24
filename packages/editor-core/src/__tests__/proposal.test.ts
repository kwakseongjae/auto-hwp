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
    };
    expect(canonicalProposalDigest(material)).toBe("fnv1a64:12f669d02eea3d03");
  });
});
