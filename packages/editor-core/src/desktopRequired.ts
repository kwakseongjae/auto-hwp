/// Desktop-required `EngineAdapter` methods (issue #64 D0).
///
/// Not re-exported from `index.ts`: the list is a CI/contract artifact, not a runtime
/// dependency of HwpWorkspace. Import this file directly from tests.
///
/// This list is a SEPARATE axis from the `?` markers on `EngineAdapter` in `adapter.ts`.
/// `?` means "an arbitrary backend may omit this method" (HwpWorkspace then degrades).
/// "Desktop required" means the two shipping backends (`WasmAdapter` + `TauriAdapter`) MUST
/// implement it for the desktop/web pair that this repo ships. A method can stay optional
/// on the interface and still be desktop-required.
///
/// `setNormalize` / `normalizeActive` are **explicitly off** for desktop — not a silent omit.
/// Those two live only on `crates/hwp-wasm`'s `HwpDoc` state machine (`normalize_on` /
/// `ls_baseline` + auto-apply at open). `crates/hwp-viewer` has 0 references. Promoting them
/// into the shared core would change the CLI `layout-check` open path and can move the
/// 8==8 / 18==18 gates; that promotion is issue #65, not D0.
///
/// `registerFont` and `dispose` are required to EXIST on the desktop adapter but are
/// documented no-ops there (native font stack / session outlives the component). The
/// contract test allows those two empty bodies and rejects any other stub.

export const DESKTOP_EXPLICITLY_OFF = ["setNormalize", "normalizeActive"] as const;

export const DESKTOP_DOCUMENTED_NOOPS = ["registerFont", "dispose"] as const;

/** Adapter methods whose TauriAdapter implementation is an `applyIntent` wrapper (not a
 *  dedicated `invoke` command). The contract test requires each name to exist as a variant
 *  of `hwp_mcp::Intent`. */
export const DESKTOP_INTENT_ROUTED_METHODS = {
  hitTestCellText: "HitTestCell",
  caretRectCell: "CaretRectCell",
  blockRunsPath: "BlockRunsPath",
  tableGrid: "TableGrid",
  docProfile: "DocProfile",
} as const;

export const DESKTOP_REQUIRED_METHODS = [
  "open",
  "pageCount",
  "pageSvg",
  "hitTest",
  "tableAt",
  "imageAt",
  "imageBbox",
  "tableCellAt",
  "blocksInRect",
  "tableColBoundaries",
  "tableRowBoundaries",
  "pageGeometry",
  "blockRuns",
  "blockRunsPath",
  "tableGrid",
  "hitTestText",
  "caretRect",
  "hitTestCellText",
  "caretRectCell",
  "find",
  "replace",
  "outline",
  "docProfile",
  "applyIntent",
  "undo",
  "redo",
  "registerFont",
  "hasFont",
  "exportPdf",
  "exportHtml",
  "toHwpx",
  "dispose",
] as const;

export type DesktopRequiredMethod = (typeof DESKTOP_REQUIRED_METHODS)[number];
export type DesktopExplicitlyOff = (typeof DESKTOP_EXPLICITLY_OFF)[number];
