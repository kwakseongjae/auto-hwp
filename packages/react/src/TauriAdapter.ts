import type { EngineAdapter } from "./EngineAdapter";
import type { BlockHit, Intent, OpenResult, Outcome, TableBox } from "./types";

/** The `invoke` surface (matches `@tauri-apps/api/core`'s `invoke`). Injected so this package has NO
 *  hard @tauri-apps dependency — the host passes its own `invoke`. */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriAdapterOptions {
  /** The Tauri `invoke`. */
  invoke: Invoke;
  /** The desktop app opens documents by PATH (a native file dialog), not by bytes. The host supplies
   *  this to bridge the web `open(bytes)` seam — e.g. write the bytes to a temp file and return the
   *  path. Reference impl: the real app migration (issue 016 follow-up) wires this to a Tauri command. */
  resolveOpenPath?: (bytes: Uint8Array, name?: string) => Promise<string>;
}

/// TauriAdapter — REFERENCE IMPLEMENTATION (not wired into the shipping desktop app; app migration is
/// an explicit follow-up per issue 016). It maps the EngineAdapter surface onto the desktop app's
/// existing Tauri commands (crates/hwp-viewer/ui/src/api.ts). Two seams are documented, not hidden:
///   • open(bytes) vs. the app's path-based `open_doc` — bridged by `resolveOpenPath`.
///   • applyIntent(Intent) vs. the app's per-op commands — this dispatches the common schema-v0 Intents
///     (SetTableCell, MoveBlock, TableInsertRows, Undo/Redo) to their command; unmapped Intents throw a
///     clear message rather than silently no-op. A future `apply_intent_json` command collapses this.
///
/// NOTE: `blocksInRect` (marquee select, issue 021) is INTENTIONALLY not implemented here — the desktop
/// app has no matching Tauri command yet (a `blocks_in_rect` command is the follow-up). The method is
/// OPTIONAL on `EngineAdapter`, so omitting it makes `HwpWorkspace` disable marquee for this backend;
/// click / ⌘-click selection still work through `hitTest`/`tableAt`.
export class TauriAdapter implements EngineAdapter {
  private invoke: Invoke;
  private resolveOpenPath?: (bytes: Uint8Array, name?: string) => Promise<string>;

  constructor(opts: TauriAdapterOptions) {
    this.invoke = opts.invoke;
    this.resolveOpenPath = opts.resolveOpenPath;
  }

  async open(bytes: Uint8Array, name?: string): Promise<OpenResult> {
    if (!this.resolveOpenPath) {
      throw new Error("TauriAdapter.open needs `resolveOpenPath` (the app opens by path, not bytes)");
    }
    const path = await this.resolveOpenPath(bytes, name);
    const r = await this.invoke<{ pages: number; editable: boolean; format: string }>("open_doc", { path });
    return { format: r.format, editable: r.editable, sections: 1, pages: r.pages };
  }

  pageCount(): Promise<number> {
    return this.invoke<number>("own_page_count");
  }

  pageSvg(page: number): Promise<string> {
    return this.invoke<string>("render_own_page", { page });
  }

  hitTest(page: number, x: number, y: number): Promise<BlockHit | null> {
    return this.invoke<BlockHit | null>("own_hit_test", { page, x, y });
  }

  tableAt(page: number, x: number, y: number): Promise<TableBox | null> {
    return this.invoke<TableBox | null>("table_at", { page, x, y });
  }

  async applyIntent(intent: Intent): Promise<Outcome> {
    switch (intent.intent) {
      case "SetTableCell": {
        const pages = await this.invoke<number>("set_table_cell", {
          section: intent.section, index: intent.index, row: intent.row, col: intent.col, text: intent.text,
        });
        return { kind: "applied", pages };
      }
      case "MoveBlock": {
        const pages = await this.invoke<number>("move_table", { section: intent.section, from: intent.from, to: intent.to });
        return { kind: "applied", pages };
      }
      case "TableInsertRows": {
        const pages = await this.invoke<number>("table_add_rows", {
          section: intent.section, index: intent.index, at: intent.at, count: intent.count, cols: intent.cols,
        });
        return { kind: "applied", pages };
      }
      case "Undo":
        return { kind: "undone", pages: await this.invoke<number>("undo") };
      case "Redo":
        return { kind: "redone", pages: await this.invoke<number>("redo") };
      default:
        throw new Error(`TauriAdapter: Intent "${intent.intent}" is not mapped to a command yet (reference impl)`);
    }
  }

  async undo(): Promise<boolean> {
    await this.invoke<number>("undo");
    return true;
  }

  async redo(): Promise<boolean> {
    await this.invoke<number>("redo");
    return true;
  }

  async registerFont(): Promise<void> {
    // The desktop build registers fonts natively (system faces); no per-call injection command.
  }

  hasFont(): boolean {
    return true; // native font stack is always available in the desktop shell
  }

  async exportPdf(): Promise<Uint8Array> {
    throw new Error("TauriAdapter.exportPdf writes to a file path via `export_doc_pdf` — use the desktop save flow");
  }

  exportHtml(): Promise<string> {
    return this.invoke<string>("render_doc_html");
  }

  async toHwpx(): Promise<Uint8Array> {
    throw new Error("TauriAdapter.toHwpx writes to a file path via `export_hwpx` — use the desktop save flow");
  }

  dispose(): void {
    /* the desktop session outlives the component; nothing to free here */
  }
}
