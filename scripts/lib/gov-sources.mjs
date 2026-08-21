/** Shared GOV-SOURCES loader (issue #71). Only KOGL-0/1 with a full sha256 and verified flag. */
export function loadGovSources(jsonText) {
  const m = JSON.parse(jsonText);
  const items = Array.isArray(m.files) ? m.files : [];
  return items.filter((i) => {
    if (!i?.file || !i?.source_url || !i?.sha256) return false;
    if (i.kogl_verified !== true) return false;
    const k = String(i.kogl ?? "");
    if (!k.startsWith("KOGL-0") && !k.startsWith("KOGL-1")) return false;
    if (!/^[0-9a-f]{64}$/i.test(String(i.sha256))) return false;
    return true;
  });
}
