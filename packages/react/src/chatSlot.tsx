/// REFERENCE side-panel wiring — **not part of the editor contract**.
///
/// `HwpWorkspace` deliberately ships no chat view (see `WorkspaceSidePanel`): the document surface is
/// the SDK's, the panel is the host's. This helper exists so a host that *wants* our reference chat
/// can mount it in one line instead of re-deriving the 13-value slot wiring:
///
/// ```tsx
/// <HwpWorkspace … sidePanel={chatSidePanel({ onAiRequest, notice: "…" })} />
/// ```
///
/// Treat `ChatPanel` as a demo affordance we happen to publish — its Korean copy, its card layout and
/// its interaction model are ours, not yours. Real products should render their own panel against
/// `WorkspaceSidePanel` and keep only the editing surface from this package.
import type { OnAiRequest } from "@auto-hwp/editor-core";
import { ChatPanel } from "./components/ChatPanel";
import type { WorkspaceSidePanel } from "./components/HwpWorkspace";

export interface ChatSlotOptions {
  /** The host AI bridge (R6) — instruction + anchors + doc context → Intents. */
  onAiRequest: OnAiRequest;
  /** Show the honest "mock" badge (no real model behind the bridge). */
  isMock?: boolean;
  /** Informational banner above the conversation (e.g. usage limits, "AI는 로컬 실행 시" 안내). */
  notice?: string;
}

export function chatSidePanel(opts: ChatSlotOptions) {
  return function renderChat(api: WorkspaceSidePanel) {
    return (
      <ChatPanel
        canEdit={api.canEdit}
        anchors={api.anchors}
        modLabel={api.modLabel}
        onRemoveAnchor={api.removeAnchor}
        onClearAnchors={api.clearAnchors}
        onConsumeAnchors={api.clearAnchors}
        onAiRequest={opts.onAiRequest}
        docContext={api.docContext}
        onApply={api.apply}
        onJumpToPage={api.jumpToPage}
        onRevealTarget={api.revealTarget}
        isMock={opts.isMock}
        aiNotice={opts.notice}
        focusToken={api.focusToken}
        previewCards={api.previewCards as never}
        onRevert={api.revert as never}
        undoDepth={api.undoDepth}
      />
    );
  };
}
