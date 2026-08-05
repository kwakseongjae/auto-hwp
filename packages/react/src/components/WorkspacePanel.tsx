import { useEffect, useRef, useState } from "react";
import type { OnAiRequest } from "@auto-hwp/editor-core";
import type { WorkspaceSidePanel } from "./HwpWorkspace";
import { ChatPanel } from "./ChatPanel";
import { DesignPanel } from "./DesignPanel";
import { ChevronLeft, ChevronRight, Sparkles, X } from "../icons";
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

  // ⚠️ 접기/열기는 **표시**만 바꾼다. children 을 언마운트하면 대화·작성 중이던 초안·검토 대기 중인
  // 제안이 통째로 날아간다(사용자 피드백: "패널을 접었다 펴면 채팅이 초기화된다"). 그래서 트리 모양은
  // 열림/닫힘에서 **동일하게 유지**하고 class/inline display 만 갈아 끼운다 — children 이 같은 위치에
  // 머물러야 리액트가 같은 인스턴스로 재조정하고 상태가 살아남는다.
  //   · rail  닫힘 → 40px 스트립 + 펼치기 버튼(본문만 숨김)
  //   · bottom/modal 닫힘 → 런처 버튼 + 레이어 통째 display:none
  // children 슬롯을 조건부 형제(`{cond && …}`)로 감싸지 마라 — false 도 자리를 차지하는 정적 JSX
  // 자식 배열이라 위치는 유지되지만, 래퍼 엘리먼트가 바뀌면 그 순간 언마운트다.
  const hidden = { display: "none" } as const;
  const railCollapsed = !open && presentation === "rail";
  const panel = (
    <aside
      className={railCollapsed ? `${frameClass} hw-sidepanel-collapsed` : frameClass}
      data-testid="hw-sidepanel"
      aria-label={ariaLabel ?? msg.panel.label}
      style={!open && presentation !== "rail" ? hidden : undefined}
    >
      {railCollapsed && (
        <button
          type="button"
          className="hw-sidepanel-expand"
          aria-label={msg.panel.openLabel}
          title={msg.panel.openLabel}
          onClick={() => onOpenChange?.(true)}
        >
          <ChevronLeft size={16} />
        </button>
      )}
      <div className="hw-sidepanel-body" style={open ? undefined : hidden} aria-hidden={open ? undefined : true}>
        {children}
      </div>
    </aside>
  );

  if (presentation === "rail" || presentation === "unstyled") return panel;
  return (
    <>
      {!open && (
        <button
          type="button"
          className={`hw-panel-launcher hw-panel-launcher-${presentation}`}
          aria-label={msg.panel.openLabel}
          title={msg.panel.openLabel}
          onClick={() => onOpenChange?.(true)}
        >
          <Sparkles size={16} />
        </button>
      )}
      <div
        className={`hw-panel-layer hw-panel-layer-${presentation}`}
        data-testid="hw-panel-layer"
        style={open ? undefined : hidden}
      >
        {open && (
          <button
            type="button"
            className="hw-panel-backdrop"
            aria-label={msg.panel.closeLabel}
            onClick={() => onOpenChange?.(false)}
          />
        )}
        {panel}
      </div>
    </>
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
          {/* 장식 글리프(✦)는 라벨에서 뺐다 — 폰트마다 다르게 그려지는 문자 대신 벡터 아이콘 하나로.
              라벨 문자열은 카탈로그(i18n)에 그대로 남아 호스트가 통째로 갈아끼울 수 있다. */}
          <Sparkles size={13} />
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
          {presentation === "rail" ? <ChevronRight size={16} /> : <X size={16} />}
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
          // 접혀 있으면 보이지 않는다 — 숨은 textarea 에 포커스를 주지 않는다(펼치는 순간 다시 잡는다).
          active={tab === "vibe" && open}
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
