// 077 — SDK i18n public surface. Re-exported from the package root (`src/index.ts`).
export { koKR } from "./koKR";
export {
  mergeMessages,
  useMergedMessages,
  useWorkspaceMessages,
  WorkspaceMessagesContext,
  WorkspaceMessagesProvider,
  type WorkspaceMessagesProviderProps,
} from "./context";
export type {
  ChatPanelMessages,
  DeepPartial,
  DesignPanelMessages,
  FindBarMessages,
  FloatingToolbarMessages,
  FontPickerMessages,
  FormatMessages,
  FormatToolbarMessages,
  ImageOverlayMessages,
  InlineEditMessages,
  OutlinePanelMessages,
  RibbonMessages,
  RulerMessages,
  SelectionActionMessages,
  StatusBarMessages,
  TableMessages,
  WorkspaceMessages,
  WorkspacePanelMessages,
  WorkspaceShellMessages,
} from "./types";
