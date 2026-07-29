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
import type { WorkspaceSidePanel } from "./components/HwpWorkspace";
import { WorkspacePanel } from "./components/WorkspacePanel";
import type { WorkspacePanelPresentation } from "./components/WorkspacePanel";

export interface WorkspacePanelSlotOptions {
  /** The host AI bridge (R6) — instruction + anchors + doc context → Intents. */
  onAiRequest: OnAiRequest;
  /** Show the honest "mock" badge (no real model behind the bridge). */
  isMock?: boolean;
  /** Informational banner above the conversation (e.g. usage limits, "AI는 로컬 실행 시" 안내). */
  notice?: string;
  /** Reference placement preset. Defaults to a right rail; consumers may choose bottom/modal/unstyled. */
  presentation?: WorkspacePanelPresentation;
}

export type ChatSlotOptions = WorkspacePanelSlotOptions;

/** One-line reference panel wiring. `chatSidePanel` remains as a backwards-compatible alias. */
export function workspacePanel(opts: WorkspacePanelSlotOptions) {
  return function renderChat(api: WorkspaceSidePanel) {
    return (
      <WorkspacePanel
        api={api}
        onAiRequest={opts.onAiRequest}
        isMock={opts.isMock}
        notice={opts.notice}
        presentation={opts.presentation}
      />
    );
  };
}

export const chatSidePanel = workspacePanel;
