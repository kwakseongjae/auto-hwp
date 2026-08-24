import { describe, expect, it } from "vitest";
import { createEditorCore } from "../core";
import type { Intent, ProposalV1 } from "../types";
import { MockAdapter } from "./mockAdapter";

class CanonicalAdapter extends MockAdapter {
  proposed: Intent[][] = [];
  commits: Array<[string, number]> = [];
  stale = false;

  override async proposeIntents(intents: Intent[]): Promise<ProposalV1> {
    this.proposed.push(intents);
    return {
      proposal_version: 1,
      proposal_id: "proposal-v1:fixture",
      digest: "fnv1a64:fixture",
      session_id: "session-1",
      document_id: "document-1",
      base_revision: 7,
      intents,
      affected_addresses: [{ section: 0, block: 1, row: null, col: null }],
      affected_pages: [0],
      capabilities: { intent_version: 0, editable: true, hwpx_export: true, hwp_export: false, pdf_export: true },
      risks: [],
      warnings: [],
    };
  }

  override async commitProposal(proposalId: string, expectedRevision: number): Promise<number> {
    this.commits.push([proposalId, expectedRevision]);
    if (this.stale) throw new Error("stale Proposal v1");
    return 1;
  }
}

describe("Proposal v1 SDK transaction", () => {
  it("scratch-previews once, commits the recorded id/revision, and records one undo unit", async () => {
    const adapter = new CanonicalAdapter();
    const core = createEditorCore(adapter);
    await core.session.open(new Uint8Array([1]), "fixture.hwpx");
    const intents = [{ intent: "SetParagraphText", section: 0, block: 1, text: "값" }];

    await core.edit.previewCards(intents);
    expect(adapter.proposed).toEqual([intents]);
    expect(adapter.applied).toEqual([]);

    await expect(core.edit.apply(intents)).resolves.toBe(1);
    expect(adapter.proposed).toHaveLength(1);
    expect(adapter.commits).toEqual([["proposal-v1:fixture", 7]]);
    await core.session.undo();
    expect(adapter.undos).toBe(1);
  });

  it("surfaces stale rejection and never records a phantom undo", async () => {
    const adapter = new CanonicalAdapter();
    const core = createEditorCore(adapter);
    await core.session.open(new Uint8Array([1]), "fixture.hwpx");
    const intents = [{ intent: "DeleteBlock", section: 0, index: 1 }];
    await core.edit.previewCards(intents);
    adapter.stale = true;
    await expect(core.edit.apply(intents)).rejects.toThrow(/stale Proposal v1/);
    expect(core.session.canUndo()).toBe(false);
  });
});
