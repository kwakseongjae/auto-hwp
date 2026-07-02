import { useCallback, useMemo, useRef } from "react";
import { catalogUrl, isTtc, type FontCatalogEntry } from "../fonts";

/// FontPicker — the font-selection UI (issue 022 §4). A catalog dropdown (each option previewed in its
/// own face), a ".ttf/.otf 업로드" button, and the current-font label. Korean labels throughout. Picking
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
          onError?.(`${entry.label}는 TTC(글꼴 컬렉션)이라 사용할 수 없습니다 — 단일 TTF/OTF 폰트를 선택하세요.`);
          return;
        }
        await onPick({ family: entry.family, bytes });
      } catch {
        onError?.(`"${entry.label}" 폰트를 불러오지 못했습니다 — 먼저 폰트를 다운로드하거나(scripts/fetch-fonts) 파일을 업로드하세요.`);
      }
    },
    [catalog, urlBase, onPick, onError],
  );

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file
      if (!file) return;
      if (!/\.(ttf|otf)$/i.test(file.name)) {
        onError?.(`지원하지 않는 형식입니다: ${file.name} — .ttf 또는 .otf 파일만 사용할 수 있습니다.`);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isTtc(bytes)) {
        onError?.(`TTC(글꼴 컬렉션)는 지원하지 않습니다: ${file.name} — 단일 TTF/OTF 파일을 사용하세요.`);
        return;
      }
      await onPick({ family: file.name.replace(/\.(ttf|otf)$/i, ""), bytes });
    },
    [onPick, onError],
  );

  return (
    <span className={`hw-fontpicker ${props.className ?? ""}`} data-testid="font-picker">
      <style>{previewCss}</style>
      <label className="hw-fontpicker-label" htmlFor="hw-font-select">
        글꼴
      </label>
      <select
        id="hw-font-select"
        className="hw-fontpicker-select"
        aria-label="글꼴 선택"
        value={selected ?? ""}
        disabled={disabled}
        onChange={(e) => void pickCatalog(e.target.value)}
      >
        {selected && !catalog.some((c) => c.family === selected) && (
          // An uploaded font isn't in the catalog — show it as the current selection.
          <option value={selected}>{selected} (업로드)</option>
        )}
        {!selected && <option value="">글꼴 선택…</option>}
        {catalog.map((e) => (
          <option key={e.family} value={e.family} style={{ fontFamily: `"tfhwp-preview-${e.file}", sans-serif` }}>
            {e.label}
            {e.bundled ? " (기본)" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="hw-fontpicker-upload"
        disabled={disabled}
        title="내 폰트 파일 업로드 (.ttf/.otf)"
        onClick={() => fileRef.current?.click()}
      >
        업로드
      </button>
      <input ref={fileRef} type="file" accept=".ttf,.otf" hidden onChange={onUpload} data-testid="font-upload-input" />
      {selected && <span className="hw-fontpicker-current" title={`현재 글꼴: ${selected}`}>현재: {selected}</span>}
    </span>
  );
}
