// First-sheet .xlsx roster reader (issue #40).
// Contract shared with crates/auto-hwp-cli/src/xlsx_roster.rs — same honesty as CSV:
// extra sheets, merged cells, and values past the header are errors, not silent shifts.

export async function parseXlsxRoster(input: ArrayBuffer | Uint8Array): Promise<Record<string, string>[]> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const files = await unzip(bytes);
  const workbook = textPart(files, "xl/workbook.xml");
  if (!workbook) throw new Error("xlsx를 읽지 못했습니다: xl/workbook.xml 없음");
  const sheetIds = workbookSheetRids(workbook);
  if (!sheetIds.length) throw new Error("xlsx 시트가 없습니다");
  if (sheetIds.length !== 1) {
    throw new Error(
      `xlsx 시트가 ${sheetIds.length}개입니다 — 첫 시트만 지원합니다. 나머지 시트를 지우거나 JSON/CSV로 보내주세요`,
    );
  }
  const rels = textPart(files, "xl/_rels/workbook.xml.rels") ?? "";
  const relMap = parseRels(rels);
  const target = relMap.get(sheetIds[0]);
  if (!target) throw new Error(`xlsx를 읽지 못했습니다: 시트 관계 ${sheetIds[0]} 없음`);
  const sheetPath = resolveXlTarget(target);
  const sheet = textPart(files, sheetPath);
  if (!sheet) throw new Error(`xlsx를 읽지 못했습니다: ${sheetPath} 없음`);
  const sstXml = textPart(files, "xl/sharedStrings.xml");
  const sst = sstXml ? parseSharedStrings(sstXml) : [];
  return rowsFromSheet(sheet, sst);
}

function textPart(files: Map<string, Uint8Array>, name: string): string | null {
  const key = name.replace(/^\/+/, "");
  const data = files.get(key) ?? files.get(`/${key}`);
  if (!data) return null;
  let s = new TextDecoder("utf-8").decode(data);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

function workbookSheetRids(xml: string): string[] {
  const ids: string[] = [];
  const re = /<([A-Za-z0-9:]*sheet)\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (localName(m[1]) !== "sheet") continue;
    const rid = attr(m[2], "id");
    if (!rid) throw new Error("xlsx를 읽지 못했습니다: 시트 r:id 없음");
    ids.push(rid);
  }
  return ids;
}

function parseRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<([A-Za-z0-9:]*Relationship)\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (localName(m[1]) !== "Relationship") continue;
    const id = attr(m[2], "Id");
    const target = attr(m[2], "Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

function resolveXlTarget(target: string): string {
  const t = target.replace(/\\/g, "/");
  if (t.startsWith("/xl/")) return t.slice(1);
  if (t.startsWith("xl/")) return t;
  if (t.startsWith("/")) return `xl${t}`;
  return `xl/${t}`;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<([A-Za-z0-9:]*si)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const inner = m[2].replace(/<([A-Za-z0-9:]*rPh)\b[^>]*>[\s\S]*?<\/\1>/g, "");
    const texts = [...inner.matchAll(/<([A-Za-z0-9:]*t)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((t) => decodeXml(t[2]));
    out.push(texts.join(""));
  }
  return out;
}

function rowsFromSheet(xml: string, sst: string[]): Record<string, string>[] {
  if (/<([A-Za-z0-9:]*mergeCell)\b/i.test(xml)) {
    throw new Error("xlsx에 병합 셀이 있습니다 — 병합을 풀거나 JSON으로 보내주세요");
  }
  const cells = new Map<string, string>();
  const cellRe = /<([A-Za-z0-9:]*c)\b([^>]*)>([\s\S]*?)<\/\1>|<([A-Za-z0-9:]*c)\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    const attrs = m[2] ?? m[5] ?? "";
    const inner = m[3] ?? "";
    if (localName(m[1] ?? m[4] ?? "") !== "c") continue;
    const ref = attr(attrs, "r");
    if (!ref) continue;
    const kind = attr(attrs, "t") ?? "";
    const parsed = parseCellRef(ref);
    if (!parsed) continue;
    const vMatch = inner.match(/<([A-Za-z0-9:]*v)\b[^>]*>([\s\S]*?)<\/\1>/);
    const tMatch = inner.match(/<([A-Za-z0-9:]*is)\b[^>]*>[\s\S]*?<([A-Za-z0-9:]*t)\b[^>]*>([\s\S]*?)<\/\2>/);
    const raw = tMatch ? decodeXml(tMatch[3]) : vMatch ? decodeXml(vMatch[2]) : "";
    const value = decodeCell(kind, raw, sst);
    if (value) cells.set(`${parsed.row},${parsed.col}`, value);
  }
  return tableFromCells(cells);
}

function decodeCell(kind: string, raw: string, sst: string[]): string {
  if (kind === "s") {
    const i = Number(raw.trim());
    if (!Number.isInteger(i) || i < 0 || i >= sst.length) {
      throw new Error(`xlsx를 읽지 못했습니다: 공유 문자열 인덱스 ${raw}`);
    }
    return sst[i];
  }
  if (kind === "b") return raw.trim() === "1" ? "TRUE" : "FALSE";
  return raw.replace(/\s+$/g, "");
}

function tableFromCells(cells: Map<string, string>): Record<string, string>[] {
  if (!cells.size) throw new Error("xlsx 헤더가 비어 있습니다");
  let minRow = Infinity;
  let maxRow = 0;
  let maxHeader = 0;
  for (const key of cells.keys()) {
    const [r, c] = key.split(",").map(Number);
    if (r < minRow) minRow = r;
    if (r > maxRow) maxRow = r;
  }
  for (const key of cells.keys()) {
    const [r, c] = key.split(",").map(Number);
    if (r === minRow && c > maxHeader) maxHeader = c;
  }
  const headers: string[] = [];
  for (let col = 0; col <= maxHeader; col++) {
    const name = (cells.get(`${minRow},${col}`) ?? "").trim();
    if (!name) {
      throw new Error(`xlsx 헤더 ${col + 1}열이 비어 있습니다 — 빈 헤더는 JSON으로 보내주세요`);
    }
    headers.push(name);
  }
  const rows: Record<string, string>[] = [];
  for (let row = minRow + 1; row <= maxRow; row++) {
    for (const key of cells.keys()) {
      const [r, c] = key.split(",").map(Number);
      if (r === row && c > maxHeader) {
        throw new Error(`xlsx ${row}행: 헤더 밖의 값이 있습니다 (${c + 1}열)`);
      }
    }
    const rec: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      const val = cells.get(`${row},${i}`) ?? "";
      if (val) any = true;
      rec[h] = val;
    });
    if (any) rows.push(rec);
  }
  if (!rows.length) throw new Error("xlsx 데이터 행이 없습니다");
  return rows;
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const row = Number(m[2]);
  if (!row) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row, col: col - 1 };
}

function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)(?:[A-Za-z0-9]+:)?${name}="([^"]*)"`);
  const m = re.exec(attrs);
  return m ? decodeXml(m[1]) : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function unzip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error("xlsx를 읽지 못했습니다: zip이 아닙니다");
  }
  const eocd = findEocd(buf);
  const entries = u16(buf, eocd + 10);
  let cd = u32(buf, eocd + 16);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < entries; i++) {
    if (u32(buf, cd) !== 0x02014b50) throw new Error("xlsx를 읽지 못했습니다: zip 중앙 디렉터리");
    const method = u16(buf, cd + 10);
    const compSize = u32(buf, cd + 20);
    const nameLen = u16(buf, cd + 28);
    const extraLen = u16(buf, cd + 30);
    const commentLen = u16(buf, cd + 32);
    const localOff = u32(buf, cd + 42);
    const name = utf8(buf.subarray(cd + 46, cd + 46 + nameLen));
    const dataStart = localOff + 30 + u16(buf, localOff + 26) + u16(buf, localOff + 28);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    files.set(name.replace(/^\/+/, ""), await inflate(method, comp));
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function findEocd(buf: Uint8Array): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(buf, i) === 0x06054b50) return i;
  }
  throw new Error("xlsx를 읽지 못했습니다: zip EOCD 없음");
}

async function inflate(method: number, data: Uint8Array): Promise<Uint8Array> {
  if (method === 0) return data;
  if (method !== 8) throw new Error(`xlsx를 읽지 못했습니다: zip method ${method}`);
  const ds = new DecompressionStream("deflate-raw");
  const ab = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(ab);
}

function u16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}
function u32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}
function utf8(b: Uint8Array): string {
  return new TextDecoder("utf-8").decode(b);
}
