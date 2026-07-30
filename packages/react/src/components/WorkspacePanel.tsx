import { useEffect, useRef, useState } from "react";
import type { OnAiRequest } from "@auto-hwp/editor-core";
import type { WorkspaceSidePanel } from "./HwpWorkspace";
import { ChatPanel } from "./ChatPanel";
import { DesignPanel } from "./DesignPanel";
import { useWorkspaceMessages } from "../i18n";

const ignoreDesignPatch = () => {};

export type WorkspacePanelTab = "vibe" | "design";
export type WorkspacePanelPresentation = "rail" | "bottom" | "modal" | "unstyled";

export interface WorkspacePanelFrameProps {
  children: React.ReactNode;
  presentation?: WorkspacePanelPresentation;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  ariaLabel?: string;
}

/** Placement-only shell for host-owned tools.
 *
 * `HwpWorkspace` owns the document surface, while this optional frame only supplies a sensible default
 * placement. Consumers can use the rail, bottom drawer or modal presets, or choose `unstyled` and keep
 * complete control of layout. The children are deliberately opaque to this component.
 */
export function WorkspacePanelFrame({
  children,
  presentation = "rail",
  open = true,
  onOpenChange,
  className,
  ariaLabel,
}: WorkspacePanelFrameProps) {
  const msg = useWorkspaceMessages();
  const frameClass = ["hw-sidepanel", `hw-sidepanel-${presentation}`, className].filter(Boolean).join(" ");

  if (!open) {
    if (presentation === "unstyled") return null;
    if (presentation === "rail") {
      return (
        <aside className={`${frameClass} hw-sidepanel-collapsed`} data-testid="hw-sidepanel">
          <button
            type="button"
            className="hw-sidepanel-expand"
            aria-label={msg.panel.openLabel}
            title={msg.panel.openLabel}
            onClick={() => onOpenChange?.(true)}
          >
            ‹
          </button>
        </aside>
      );
    }
    return (
      <button
        type="button"
        className={`hw-panel-launcher hw-panel-launcher-${presentation}`}
        aria-label={msg.panel.openLabel}
        onClick={() => onOpenChange?.(true)}
      >
        ✦
      </button>
    );
  }

  const panel = (
    <aside className={frameClass} data-testid="hw-sidepanel" aria-label={ariaLabel ?? msg.panel.label}>
      {children}
    </aside>
  );

  if (presentation === "rail" || presentation === "unstyled") return panel;
  return (
    <div className={`hw-panel-layer hw-panel-layer-${presentation}`} data-testid="hw-panel-layer">
      <button
        type="button"
        className="hw-panel-backdrop"
        aria-label={msg.panel.closeLabel}
        onClick={() => onOpenChange?.(false)}
      />
      {panel}
    </div>
  );
}

export interface WorkspacePanelProps {
  api: WorkspaceSidePanel;
  onAiRequest: OnAiRequest;
  isMock?: boolean;
  notice?: string;
  /** Default placement only. Choose `unstyled` when the host supplies every pixel itself. */
  presentation?: WorkspacePanelPresentation;
  /** Controlled tab. Omit to let the reference panel switch between vibe/design automatically. */
  tab?: WorkspacePanelTab;
  defaultTab?: WorkspacePanelTab;
  onTabChange?: (tab: WorkspacePanelTab) => void;
  /** Controlled visibility. Omit for the reference panel's internal open/collapse state. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Reference panel: conversation and deterministic manual design controls share one stable surface.
 * Both panes stay mounted so switching tabs never discards a draft, proposal, or chat history. */
export function WorkspacePanel({
  api,
  onAiRequest,
  isMock,
  notice,
  presentation = "rail",
  tab: controlledTab,
  defaultTab = "vibe",
  onTabChange,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
}: WorkspacePanelProps) {
  const msg = useWorkspaceMessages();
  const [internalTab, setInternalTab] = useState<WorkspacePanelTab>(defaultTab);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const tab = controlledTab ?? internalTab;
  const open = controlledOpen ?? internalOpen;
  const setTab = (next: WorkspacePanelTab) => {
    if (controlledTab === undefined) setInternalTab(next);
    onTabChange?.(next);
  };
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const selectionKey = api.designSelection
    ? `${api.designSelection.kind}:${api.designSelection.page}:${api.designSelection.section}:${api.designSelection.block}`
    : "";
  const previousSelectionKey = useRef("");
  const previousFocusToken = useRef(api.focusToken);

  useEffect(() => {
    const previous = previousSelectionKey.current;
    const focusChanged = api.focusToken !== previousFocusToken.current;
    previousFocusToken.current = api.focusToken;
    previousSelectionKey.current = selectionKey;
    // An explicit "AI에게 전달" action wins over a selection refresh from the same edit frame.
    if (focusChanged && api.focusToken > 0) {
      setOpen(true);
      setTab("vibe");
    } else if (selectionKey && selectionKey !== previous) {
      setOpen(true);
      setTab("design");
    } else if (!selectionKey && previous) {
      setTab("vibe");
    }
    // Controlled callbacks intentionally do not retrigger selection synchronization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.focusToken, selectionKey]);

  return (
    <WorkspacePanelFrame
      presentation={presentation}
      open={open}
      onOpenChange={setOpen}
      className={className}
    >
      <div className="hw-sidepanel-tabs" role="tablist" aria-label={msg.panel.label}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "vibe"}
          className={tab === "vibe" ? "is-active" : ""}
          onClick={() => setTab("vibe")}
        >
          {msg.panel.tabVibe}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "design"}
          className={tab === "design" ? "is-active" : ""}
          data-testid="hw-design-tab"
          onClick={() => setTab("design")}
        >
          {msg.panel.tabDesign}
        </button>
        <button
          type="button"
          className="hw-sidepanel-collapse"
          aria-label={presentation === "rail" ? msg.panel.collapseLabel : msg.panel.closeLabel}
          title={presentation === "rail" ? msg.panel.collapseLabel : msg.panel.closeLabel}
          onClick={() => setOpen(false)}
        >
          {presentation === "rail" ? "›" : "×"}
        </button>
      </div>

      <div className={`hw-sidepanel-pane${tab === "vibe" ? " is-active" : ""}`} aria-hidden={tab !== "vibe"}>
        <ChatPanel
          canEdit={api.canEdit}
          anchors={api.anchors}
          modLabel={api.modLabel}
          onRemoveAnchor={api.removeAnchor}
          onClearAnchors={api.clearAnchors}
          onConsumeAnchors={api.clearAnchors}
          onAiRequest={onAiRequest}
          docContext={api.docContext}
          onApply={api.apply}
          onJumpToPage={api.jumpToPage}
          onRevealTarget={api.revealTarget}
          isMock={isMock}
          aiNotice={notice}
          focusToken={api.focusToken}
          active={tab === "vibe"}
          previewCards={api.previewCards as never}
          onRevert={api.revert as never}
          undoDepth={api.undoDepth}
        />
      </div>

      <div className={`hw-sidepanel-pane${tab === "design" ? " is-active" : ""}`} aria-hidden={tab !== "design"}>
        <DesignPanel
          selection={api.designSelection ?? null}
          fonts={api.designFonts}
          onPatch={api.applyDesign ?? ignoreDesignPatch}
          textEditing={api.textEditing}
        />
      </div>
    </WorkspacePanelFrame>
  );
}
