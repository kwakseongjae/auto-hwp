import { useCallback, useMemo, useRef } from "react";
import { catalogUrl, isTtc, type FontCatalogEntry } from "../fonts";
import { useWorkspaceMessages } from "../i18n";

/// FontPicker — the font-selection UI (issue 022 §4). A catalog dropdown (each option previewed in its
/// own face), a ".ttf/.otf 업로드" button, and the current-font label. Copy comes from the injectable
/// catalog (issue 077 — `messages.fontPicker`), defaulting to Korean. Picking
/// a font resolves its BYTES (fetch a catalog URL, or read the uploaded file) and hands them to `onPick`;
/// the workspace then `registerFont`s them (metrics + PDF) and re-renders. A **TTC is rejected** with an
/// explicit Korean error (krilla/our shaper can't subset a collection — issue §함정), before registration.
///
/// This is a NEW, self-contained component (it does NOT touch the 021-owned SelectionOverlay). Errors
/// are surfaced through `onError` (Korean) so the host shows them in its own status/toast surface.
export interface FontPickerProps {
  /** The curated OFL catalog (see `FONT_CATALOG`). Each entry may be repo-bundled or fetch-on-demand. */
  catalog: readonly FontCatalogEntry[];
  /** The currently applied font family name (shown as "현재 글꼴"), or null before any selection. */
  selected: string | null;
  /** Resolve + hand the picked font to the host: `{ family, bytes }`. May be async (fetch). */
  onPick: (font: { family: string; bytes: Uint8Array }) => void | Promise<void>;
  /** Surface a Korean error (download failure / TTC rejection). */
  onError?: (message: string) => void;
  /** Base URL the catalog fonts are served from (default `/fonts`). */
  urlBase?: string;
  /** Disable while no document is open. */
  disabled?: boolean;
  className?: string;
}

export function FontPicker(props: FontPickerProps) {
  const msg = useWorkspaceMessages();
  const { catalog, selected, onPick, onError, urlBase, disabled } = props;
  const fileRef = useRef<HTMLInputElement>(null);

  // Preview each option in its own face: inject an @font-face per catalog entry (best-effort — an
  // undownloaded font simply falls back to the default UI font in the dropdown).
  const previewCss = useMemo(
    () =>
      catalog
        .map((e) => `@font-face { font-family: "tfhwp-preview-${e.file}"; src: url("${catalogUrl(e, urlBase)}"); }`)
        .join("\n"),
    [catalog, urlBase],
  );

  const pickCatalog = useCallback(
    async (family: string) => {
      const entry = catalog.find((e) => e.family === family);
      if (!entry) return;
      try {
        const res = await fetch(catalogUrl(entry, urlBase));
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (isTtc(bytes)) {
          onError?.(msg.fontPicker.ttcCatalogError(entry.label));
          return;
        }
        await onPick({ family: entry.family, bytes });
      } catch {
        onError?.(msg.fontPicker.loadError(entry.label));
      }
    },
    [catalog, urlBase, onPick, onError, msg],
  );

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file
      if (!file) return;
      if (!/\.(ttf|otf)$/i.test(file.name)) {
        onError?.(msg.fontPicker.unsupportedFormat(file.name));
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isTtc(bytes)) {
        onError?.(msg.fontPicker.ttcUploadError(file.name));
        return;
      }
      await onPick({ family: file.name.replace(/\.(ttf|otf)$/i, ""), bytes });
    },
    [onPick, onError, msg],
  );

  return (
    <span className={`hw-fontpicker ${props.className ?? ""}`} data-testid="font-picker">
      <style>{previewCss}</style>
      <label className="hw-fontpicker-label" htmlFor="hw-font-select">
        {msg.fontPicker.label}
      </label>
      <select
        id="hw-font-select"
        className="hw-fontpicker-select"
        aria-label={msg.fontPicker.selectLabel}
        value={selected ?? ""}
        disabled={disabled}
        onChange={(e) => void pickCatalog(e.target.value)}
      >
        {selected && !catalog.some((c) => c.family === selected) && (
          // An uploaded font isn't in the catalog — show it as the current selection.
          <option value={selected}>{msg.fontPicker.uploadedOption(selected)}</option>
        )}
        {!selected && <option value="">{msg.fontPicker.placeholder}</option>}
        {catalog.map((e) => (
          <option key={e.family} value={e.family} style={{ fontFamily: `"tfhwp-preview-${e.file}", sans-serif` }}>
            {e.label}
            {e.bundled ? msg.fontPicker.bundledSuffix : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="hw-fontpicker-upload"
        disabled={disabled}
        title={msg.fontPicker.uploadTitle}
        onClick={() => fileRef.current?.click()}
      >
        {msg.fontPicker.upload}
      </button>
      <input ref={fileRef} type="file" accept=".ttf,.otf" hidden onChange={onUpload} data-testid="font-upload-input" />
      {selected && <span className="hw-fontpicker-current" title={msg.fontPicker.currentTitle(selected)}>{msg.fontPicker.current(selected)}</span>}
    </span>
  );
}
