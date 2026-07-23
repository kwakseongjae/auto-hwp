"use client";
// 벌크 채움 웹 테스트 환경 (issue 073 — CLI inspect/fill의 브라우저 판 + 필드 스튜디오).
// **전 과정 결정론 · LLM 0콜 · 100% 클라이언트**: 인스펙션(라벨→pin 초안)·영역 지정(문서 클릭→셀
// 결정론 매핑 + 호버 미리보기)·규정(타입/필수)·규격 저장(fillmap JSON 재사용)·채움(SetTableCell)·
// 검증(값+쪽수+형식)·검수 캐러셀(실렌더+하이라이트)·zip까지 엔진 API만 쓴다. 정적 데모에서도 동작.
// 규칙은 crates/auto-hwp-cli/src/fill.rs와 한 벌 — 스키마는 additive(autohwp.fillmap.v1 + spec).
// 호버 셀 하이라이트는 ref 직접 스타일(마우스무브당 리렌더 0). 필드 식별은 안정 id(이름 편집 중
// 리마운트로 포커스가 날아가는 함정 — 이름을 React key로 쓰지 말 것).
import { useCallback, useMemo, useRef, useState } from "react";
import { HwpDoc, initEngine } from "@auto-hwp/engine";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

// CLI fill.rs와 동일 렉시콘/정규화 — 두 표면이 같은 초안을 내야 한다.
const LEXICON = ["성명", "이름", "생년월일", "연락처", "전화번호", "휴대전화", "주소", "이메일", "기업명", "업체명", "회사명", "대표자", "사업자등록번호", "법인등록번호", "서명", "날짜", "작성일", "기간", "계약기간", "소속", "직위", "부서"];
const norm = (s: string) => (s || "").replace(/[\s()·:：'"※]/g, "");

/** 규정(spec) 타입 — 채움 시 형식 검증(위반 = format_mismatch로 보고, 조용히 넘기지 않음). */
const SPEC_TYPES: Record<string, { label: string; re: RegExp | null; hint: string }> = {
  text: { label: "텍스트", re: null, hint: "" },
  date: { label: "날짜", re: /^\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*[.일]?\s*$/, hint: "예: 2026.01.01" },
  phone: { label: "전화번호", re: /^0\d{1,2}-?\d{3,4}-?\d{4}$/, hint: "예: 010-1234-5678" },
  bizno: { label: "사업자번호", re: /^\d{3}-?\d{2}-?\d{5}$/, hint: "예: 123-45-67890" },
  number: { label: "숫자/금액", re: /^[\d,]+원?$/, hint: "예: 1,000,000" },
};

interface Pin {
  section: number;
  index: number;
  row: number;
  col: number;
}
interface Field {
  id: number; // 안정 식별자 — React key/선택은 이걸로(이름은 편집 가능해야 하므로 key로 못 쓴다)
  key: string;
  label: string;
  pin: Pin;
  example: string;
  ambiguous: number;
  use: boolean;
  required: boolean;
  specType: string; // SPEC_TYPES 키
}
interface RowResult {
  name: string;
  fileName: string;
  bytes: Uint8Array;
  reasons: string[];
  svg: string; // 채운 셀이 있는 페이지의 sanitized SVG
  pageW: number;
  pageH: number;
  highlights: { x: number; y: number; w: number; h: number; key: string; value: string }[];
  values: { key: string; value: string; addr: string; example: string }[];
}

/** 최소 STORE zip(무압축 — hwpx는 이미 zip이라 재압축 무익). 의존성 0. */
function storeZip(files: { name: string; bytes: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (...bs: Uint8Array[]) => {
    const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of bs) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  };
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(f.bytes.length), u32(f.bytes.length), u16(name.length), u16(0), name, f.bytes);
    chunks.push(local);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(f.bytes.length), u32(f.bytes.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
    offset += local.length;
  }
  const cd = cat(...central);
  const end = cat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0));
  return new Blob([cat(...chunks), cd, end], { type: "application/zip" });
}

/** 문서의 전 표 블록 결정론 열거(blocksInRect 페이지 스캔) — 프로필 표 목록은 컨텍스트 캡(20)이
 *  있어 인스펙션·검증 공용으로 이걸 쓴다(뒤쪽 표 누락 = 거짓 value_not_found의 원인이었다). */
function allTables(doc: HwpDoc): { section: number; block: number }[] {
  const out: { section: number; block: number }[] = [];
  const seen = new Set<string>();
  for (let pg = 0; pg < doc.pageCount(); pg++) {
    for (const h of doc.blocksInRect(pg, 0, 0, 100000, 100000) as { section: number; block: number; kind: string }[]) {
      const k = h.section + ":" + h.block;
      if (h.kind === "table" && !seen.has(k)) {
        seen.add(k);
        out.push(h);
      }
    }
  }
  return out;
}

/** (section, block) → 그 블록이 처음 나타나는 페이지. 스튜디오 오버레이·클릭 매핑 공용. */
function buildPageOfBlock(doc: HwpDoc): Map<string, number> {
  const map = new Map<string, number>();
  for (let pg = 0; pg < doc.pageCount(); pg++) {
    for (const h of doc.blocksInRect(pg, 0, 0, 100000, 100000) as { section: number; block: number; kind: string }[]) {
      const k = h.section + ":" + h.block;
      if (h.kind === "table" && !map.has(k)) map.set(k, pg);
    }
  }
  return map;
}

/** 명단 파싱 — 4형식 자동 감지(전부 결정론):
 *  ① JSON 배열  ② "키: 값" 블록 txt(빈 줄로 인원 구분 — 손으로 쓰기 가장 쉬움)
 *  ③ TSV(탭 — 엑셀 복사 붙여넣기)  ④ CSV(콤마 — 따옴표 발견 시 정직 거부, JSON 권장) */
function parseRoster(text: string): Record<string, string>[] {
  const t = text.trim();
  if (!t) throw new Error("명단이 비어 있습니다");
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as Record<string, string>[];
    if (!Array.isArray(arr)) throw new Error("JSON은 객체 배열이어야 합니다");
    return arr;
  }
  const lines = t.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? "";
  // ② 키: 값 블록 — 첫 유효 줄이 "키: 값" 꼴이고 구분자(콤마/탭)가 없을 때
  if (/^[^,\t:]{1,20}:\s*\S/.test(first.trim())) {
    const rows: Record<string, string>[] = [];
    let cur: Record<string, string> = {};
    for (const line of [...lines, ""]) {
      const l = line.trim();
      if (!l) {
        if (Object.keys(cur).length) rows.push(cur);
        cur = {};
        continue;
      }
      const i = l.indexOf(":");
      if (i <= 0) throw new Error(`"키: 값" 형식이 아닌 줄: "${l.slice(0, 30)}"`);
      cur[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    if (!rows.length) throw new Error("빈 명단");
    return rows;
  }
  // ③/④ 표 형식
  const delim = first.includes("\t") ? "\t" : ",";
  if (delim === "," && t.includes('"')) throw new Error("CSV에 따옴표가 있습니다 — 내장 콤마/따옴표는 JSON 또는 탭(TSV)으로 넣어주세요");
  const rows = lines.filter((l) => l.trim());
  const header = rows[0].split(delim).map((h) => h.trim());
  return rows.slice(1).map((line, i) => {
    const cells = line.split(delim);
    if (cells.length !== header.length) throw new Error(`${i + 2}행: 열 수 ${cells.length} ≠ 헤더 ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? "").trim()]));
  });
}

/** 파일 → 텍스트(한국 실무 CSV는 CP949가 흔함 — UTF-8 실패 시 EUC-KR 폴백). */
async function readTextFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 사용자가 정의한 필드로 명단 "형식 예시"(키: 값 블록 — 콤마 걱정 없는 권장 형식)를 만든다. */
function buildRosterTemplate(fields: Field[]): string {
  const line = (f: Field) => `${f.key}: ${SPEC_TYPES[f.specType]?.hint.replace("예: ", "") ?? ""}`;
  const person = fields.map(line).join("\n");
  return `${person}\n\n${fields.map((f) => `${f.key}: `).join("\n")}`;
}

/** 사용자가 정의한 필드·규정 그대로를 담은 "AI에게 줄 프롬프트" — ChatGPT/Claude 등 아무 AI에
 *  원본 자료와 함께 붙여넣으면 우리 파서가 읽는 "키: 값" 블록이 나온다. 채움 자체는 계속 결정론. */
function buildAiPrompt(fields: Field[]): string {
  const rules = fields
    .map((f) => {
      const spec = SPEC_TYPES[f.specType];
      const parts = [spec?.label ?? "텍스트"];
      if (spec?.hint) parts.push(spec.hint);
      if (f.required) parts.push("필수");
      return `- ${f.key}: ${parts.join(" · ")}`;
    })
    .join("\n");
  const skeleton = fields.map((f) => `${f.key}: (값)`).join("\n");
  return `아래 "원본 자료"에서 각 사람의 정보를 추출해, 다음 형식 그대로만 출력해줘(설명·코드블록·번호 없이 본문만):

${skeleton}

(다음 사람은 빈 줄 하나 띄우고 같은 형식 반복)

규칙:
${rules}
- 원본에 없는 값은 지어내지 말고 "필드명:" 뒤를 빈칸으로 둬.
- 필드 이름은 위와 한 글자도 다르지 않게.

원본 자료:
(여기에 엑셀 복사본·메모·기존 문서 등 원본을 붙여넣으세요)`;
}

export default function BulkFillPage() {
  const [tpl, setTpl] = useState<{ bytes: Uint8Array; name: string; sha: string; pages: number } | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [rosterText, setRosterText] = useState("");
  const [results, setResults] = useState<RowResult[]>([]);
  const [baseline, setBaseline] = useState(0);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [studioPage, setStudioPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const inited = useRef(false);
  const nextId = useRef(1);
  // 스튜디오용으로 템플릿 문서를 열어둔다(렌더·클릭 매핑·오버레이 지오메트리) — 새 업로드 때 교체.
  const tplDocRef = useRef<HwpDoc | null>(null);
  const pageOfBlockRef = useRef<Map<string, number>>(new Map());
  const hoverRef = useRef<HTMLDivElement | null>(null); // 호버 셀 박스 — ref 직접 스타일(리렌더 0)

  const ensureEngine = useCallback(async () => {
    if (!inited.current) {
      await initEngine(new URL(`${BASE}/hwp/hwp_wasm_bg.wasm`, window.location.origin));
      inited.current = true;
    }
  }, []);

  // ── 1) 템플릿 업로드 → 결정론 인스펙션(fill-map 초안) ─────────────────────────────────────────
  const onTemplate = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setResults([]);
      setSelectedId(null);
      setBusy("양식 분석 중…");
      try {
        await ensureEngine();
        const bytes = new Uint8Array(await file.arrayBuffer());
        tplDocRef.current?.free();
        const doc = HwpDoc.open(bytes, file.name);
        tplDocRef.current = doc;
        pageOfBlockRef.current = buildPageOfBlock(doc);
        const seen = new Map<string, number>();
        const drafted: Field[] = [];
        for (const t of allTables(doc)) {
          const grid = doc.tableGrid(t.section, t.block);
          if (!grid) continue;
          for (const cell of grid.cells) {
            const n = norm(cell.text);
            if (!n || n.length > 20) continue;
            const label = LEXICON.find((l) => n.startsWith(norm(l)));
            if (!label) continue;
            seen.set(label, (seen.get(label) ?? 0) + 1);
            if ((seen.get(label) ?? 0) > 1) continue;
            const right = grid.cells.filter((c) => c.row === cell.row && c.col > cell.col).sort((a, b) => a.col - b.col)[0];
            if (!right) continue;
            drafted.push({
              id: nextId.current++,
              key: label,
              label: cell.text.trim(),
              pin: { section: grid.section, index: grid.block, row: right.row, col: right.col },
              example: (right.text || "").trim(),
              ambiguous: 0,
              use: true,
              required: false,
              specType: "text",
            });
          }
        }
        for (const f of drafted) f.ambiguous = (seen.get(f.key) ?? 1) - 1;
        setTpl({ bytes, name: file.name, sha: await sha256hex(bytes), pages: doc.pageCount() });
        setFields(drafted);
        const firstPage = drafted.length ? (pageOfBlockRef.current.get(`${drafted[0].pin.section}:${drafted[0].pin.index}`) ?? 0) : 0;
        setStudioPage(firstPage);
        if (drafted.length === 0) setNotice("자동 유도된 필드가 없습니다 — 아래 문서에서 채울 셀을 직접 클릭해 지정하세요.");
      } catch (e) {
        setError(`양식 분석 실패: ${e}`);
      } finally {
        setBusy(null);
      }
    },
    [ensureEngine],
  );

  // ── 스튜디오: 페이지 렌더 + 필드 오버레이 + 클릭→셀 결정론 매핑 ──────────────────────────────
  const studio = useMemo(() => {
    const doc = tplDocRef.current;
    if (!tpl || !doc) return null;
    const svg = doc.renderPageSvgSanitized(studioPage);
    const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const pageW = m ? parseFloat(m[1]) : 1;
    const pageH = m ? parseFloat(m[2]) : 1;
    const tables: { section: number; block: number; cols: number[]; rows: number[] }[] = [];
    for (const h of doc.blocksInRect(studioPage, 0, 0, 100000, 100000) as { section: number; block: number; kind: string }[]) {
      if (h.kind !== "table") continue;
      const cols = doc.tableColBoundaries(studioPage, h.section, h.block);
      const rows = doc.tableRowBoundaries(studioPage, h.section, h.block);
      if (cols && rows && cols.length > 1 && rows.length > 1) tables.push({ section: h.section, block: h.block, cols, rows });
    }
    const overlays: { id: number; key: string; x: number; y: number; w: number; h: number; selected: boolean }[] = [];
    for (const f of fields) {
      if (!f.use) continue;
      if ((pageOfBlockRef.current.get(`${f.pin.section}:${f.pin.index}`) ?? -1) !== studioPage) continue;
      const t = tables.find((t) => t.section === f.pin.section && t.block === f.pin.index);
      if (!t || f.pin.col + 1 >= t.cols.length || f.pin.row + 1 >= t.rows.length) continue;
      overlays.push({
        id: f.id,
        key: f.key,
        x: t.cols[f.pin.col],
        y: t.rows[f.pin.row],
        w: t.cols[f.pin.col + 1] - t.cols[f.pin.col],
        h: t.rows[f.pin.row + 1] - t.rows[f.pin.row],
        selected: f.id === selectedId,
      });
    }
    return { svg, pageW, pageH, tables, overlays };
  }, [tpl, studioPage, fields, selectedId]);

  /** 마우스 좌표(px 페이지 공간) → 표 셀. 클릭/호버 공용. */
  const cellAt = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!studio) return null;
      const rect = e.currentTarget.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * studio.pageW;
      const py = ((e.clientY - rect.top) / rect.height) * studio.pageH;
      for (const t of studio.tables) {
        const ci = t.cols.findIndex((x, i) => i + 1 < t.cols.length && px >= x && px < t.cols[i + 1]);
        const ri = t.rows.findIndex((y, i) => i + 1 < t.rows.length && py >= y && py < t.rows[i + 1]);
        if (ci < 0 || ri < 0) continue;
        return { t, ci, ri };
      }
      return null;
    },
    [studio],
  );

  /** 호버 셀 미리보기 — ref 직접 스타일이라 마우스무브당 리렌더 0. */
  const onStudioMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const box = hoverRef.current;
      if (!box || !studio) return;
      const hit = cellAt(e);
      if (!hit) {
        box.style.opacity = "0";
        return;
      }
      const { t, ci, ri } = hit;
      box.style.opacity = "1";
      box.style.left = `${(t.cols[ci] / studio.pageW) * 100}%`;
      box.style.top = `${(t.rows[ri] / studio.pageH) * 100}%`;
      box.style.width = `${((t.cols[ci + 1] - t.cols[ci]) / studio.pageW) * 100}%`;
      box.style.height = `${((t.rows[ri + 1] - t.rows[ri]) / studio.pageH) * 100}%`;
    },
    [studio, cellAt],
  );

  /** 문서 클릭 → 기존 필드면 선택(+카드 스크롤), 새 셀이면 필드 추가(좌측 라벨을 이름 초안으로). */
  const onStudioClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const doc = tplDocRef.current;
      if (!studio || !doc) return;
      const hit = cellAt(e);
      if (!hit) {
        setNotice("표 셀 위를 클릭하세요 — 표 밖 영역은 v1에서 지정할 수 없습니다.");
        return;
      }
      const { t, ci, ri } = hit;
      const existing = fields.find((f) => f.pin.section === t.section && f.pin.index === t.block && f.pin.row === ri && f.pin.col === ci);
      if (existing) {
        setSelectedId(existing.id);
        document.getElementById(`bulk-fc-${existing.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      const grid = doc.tableGrid(t.section, t.block);
      const cell = grid?.cells.find((c) => c.row === ri && c.col === ci);
      if (!cell) {
        setNotice("병합으로 덮인 셀입니다 — 병합의 좌상단(값이 표시되는) 셀을 클릭하세요.");
        return;
      }
      const left = grid!.cells.filter((c) => c.row === ri && c.col < ci).sort((a, b) => b.col - a.col)[0];
      const draftName = (left?.text || "").trim().replace(/\s+/g, " ").slice(0, 12);
      let key = draftName || `필드${fields.length + 1}`;
      let n = 2;
      while (fields.some((f) => f.key === key)) key = `${draftName || "필드"}${n++}`;
      const id = nextId.current++;
      setFields((fs) => [...fs, { id, key, label: draftName || "(직접 지정)", pin: { section: t.section, index: t.block, row: ri, col: ci }, example: (cell.text || "").trim(), ambiguous: 0, use: true, required: false, specType: "text" }]);
      setSelectedId(id);
      setNotice(null);
      requestAnimationFrame(() => document.getElementById(`bulk-fc-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    },
    [studio, fields, cellAt],
  );

  // ── 규격 저장/불러오기(fillmap v1 + spec — additive) ─────────────────────────────────────────
  const saveSpec = useCallback(() => {
    if (!tpl) return;
    const map = {
      schema: "autohwp.fillmap.v1",
      template: { path: tpl.name, sha256: tpl.sha },
      fields: fields.filter((f) => f.use).map((f) => ({ key: f.key, target: { kind: "label-right", label: f.label }, pin: f.pin, example: f.example, required: f.required, spec: { type: f.specType } })),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(map, null, 2)], { type: "application/json" }));
    a.download = `${tpl.name.replace(/\.(hwpx?|HWPX?)$/, "")}.fillmap.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, [tpl, fields]);

  const loadSpec = useCallback(
    async (file: File) => {
      try {
        const map = JSON.parse(await readTextFile(file));
        if (map.schema !== "autohwp.fillmap.v1") throw new Error("schema가 autohwp.fillmap.v1이 아닙니다");
        if (tpl && map.template?.sha256 && map.template.sha256 !== tpl.sha) setNotice("⚠ 규격의 템플릿 지문(sha256)이 현재 양식과 다릅니다 — 같은 양식인지 확인하세요.");
        setFields(
          (map.fields as Array<{ key: string; target?: { label?: string }; pin: Pin; example?: string; required?: boolean; spec?: { type?: string } }>).map((f) => ({
            id: nextId.current++,
            key: f.key,
            label: f.target?.label ?? f.key,
            pin: f.pin,
            example: f.example ?? "",
            ambiguous: 0,
            use: true,
            required: !!f.required,
            specType: f.spec?.type && SPEC_TYPES[f.spec.type] ? f.spec.type : "text",
          })),
        );
      } catch (e) {
        setError(`규격 불러오기 실패: ${e}`);
      }
    },
    [tpl],
  );

  // ── 2) 생성: 인원별 채움 → 재개봉 검증(값+쪽수+형식) → 프리뷰 렌더+하이라이트 ────────────────
  const generate = useCallback(async () => {
    if (!tpl) return;
    setError(null);
    setBusy("생성 중…");
    try {
      await ensureEngine();
      const rows = parseRoster(rosterText);
      const active = fields.filter((f) => f.use);
      const dup = active.map((f) => f.key).filter((k, i, a) => a.indexOf(k) !== i);
      if (dup.length) throw new Error(`필드 이름이 중복됩니다: ${[...new Set(dup)].join(", ")} — 2단계에서 이름을 구분해 주세요`);
      // 쪽수 기준선 = 무편집 왕복(CLI와 동일 — .hwp 템플릿의 변환 리플로를 정직 반영)
      const b0 = HwpDoc.open(tpl.bytes, tpl.name);
      const noEdit = b0.toHwpx();
      b0.free();
      const bl = HwpDoc.open(new Uint8Array(noEdit), "baseline.hwpx");
      const basePages = bl.pageCount();
      bl.free();
      setBaseline(basePages);

      const nameKey = active.find((f) => f.key === "성명" || f.key === "이름")?.key ?? active[0]?.key;
      const out: RowResult[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const reasons: string[] = [];
        const doc = HwpDoc.open(tpl.bytes, tpl.name);
        const filled: { key: string; value: string; addr: string; example: string }[] = [];
        for (const f of active) {
          const value = (row[f.key] ?? "").trim();
          if (!value) {
            if (f.required) reasons.push(`missing_required:${f.key}`);
            continue;
          }
          const spec = SPEC_TYPES[f.specType];
          if (spec?.re && !spec.re.test(value)) reasons.push(`format_mismatch:${f.key}(${spec.label} 형식 아님: "${value}")`);
          try {
            doc.applyIntent({ intent: "SetTableCell", section: f.pin.section, index: f.pin.index, row: f.pin.row, col: f.pin.col, text: value });
            filled.push({ key: f.key, value, addr: `s${f.pin.section}·b${f.pin.index}·r${f.pin.row}c${f.pin.col}`, example: f.example });
          } catch (e) {
            reasons.push(`apply_failed:${f.key}:${e}`);
          }
        }
        const bytes = new Uint8Array(doc.toHwpx());
        doc.free();

        // 재개봉 검증 + 프리뷰(첫 채움 셀이 있는 페이지 렌더 + 셀 경계 하이라이트 — 전부 지오메트리 API)
        const check = HwpDoc.open(bytes, "check.hwpx");
        const pages = check.pageCount();
        if (pages !== basePages) reasons.push(`overflow:pages_${pages}_vs_${basePages}`);
        let svg = "";
        let pageW = 1;
        let pageH = 1;
        const highlights: RowResult["highlights"] = [];
        if (filled.length) {
          // 산출물에서 채운 값의 셀을 재탐색(왕복 후 블록 인덱스 재배열을 값 스캔으로 흡수 — 073 함정 ②)
          const checkTables = allTables(check);
          let target: { section: number; block: number } | null = null;
          for (const t of checkTables) {
            const g = check.tableGrid(t.section, t.block);
            if (g?.cells.some((c) => c.text === filled[0].value)) {
              target = { section: g.section, block: g.block };
              break;
            }
          }
          for (const f of filled) {
            const found = checkTables.some((t) => check.tableGrid(t.section, t.block)?.cells.some((c) => c.text === f.value));
            if (!found) reasons.push(`value_not_found:${f.key}`);
          }
          if (target) {
            for (let p = 0; p < pages; p++) {
              const hits = check.blocksInRect(p, 0, 0, 100000, 100000) as { section: number; block: number }[];
              if (!hits.some((h) => h.section === target!.section && h.block === target!.block)) continue;
              svg = check.renderPageSvgSanitized(p);
              const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
              pageW = m ? parseFloat(m[1]) : 1;
              pageH = m ? parseFloat(m[2]) : 1;
              const cols = check.tableColBoundaries(p, target.section, target.block);
              const rowsB = check.tableRowBoundaries(p, target.section, target.block);
              if (cols && rowsB) {
                const g = check.tableGrid(target.section, target.block);
                for (const f of filled) {
                  const cell = g?.cells.find((c) => c.text === f.value);
                  if (!cell || cell.col + 1 >= cols.length || cell.row + 1 >= rowsB.length) continue;
                  highlights.push({ x: cols[cell.col], y: rowsB[cell.row], w: cols[cell.col + 1] - cols[cell.col], h: rowsB[cell.row + 1] - rowsB[cell.row], key: f.key, value: f.value });
                }
              }
              break;
            }
          }
        }
        check.free();
        const person = (nameKey && row[nameKey]) || row[Object.keys(row)[0]] || `${i + 1}`;
        out.push({
          name: String(person),
          fileName: `${String(i + 1).padStart(3, "0")}_${String(person).replace(/[/\\:*?"<>|\n]/g, "_")}.hwpx`,
          bytes,
          reasons,
          svg,
          pageW,
          pageH,
          highlights,
          values: filled,
        });
        setBusy(`생성 중… ${i + 1}/${rows.length}`);
      }
      setResults(out);
      setIdx(0);
    } catch (e) {
      setError(`생성 실패: ${e}`);
    } finally {
      setBusy(null);
    }
  }, [tpl, fields, rosterText, ensureEngine]);

  const downloadZip = useCallback(() => {
    const report = {
      template: tpl?.name,
      templateSha256: tpl?.sha,
      baselinePages: baseline,
      rows: results.map((r) => ({ file: r.fileName, needsReview: r.reasons.length > 0, reasons: r.reasons })),
    };
    const blob = storeZip([
      ...results.map((r) => ({ name: r.fileName, bytes: r.bytes })),
      { name: "report.json", bytes: new TextEncoder().encode(JSON.stringify(report, null, 2)) },
    ]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "벌크채움_결과.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, [results, tpl, baseline]);

  const cur = results[idx];
  const review = results.filter((r) => r.reasons.length > 0).length;
  const selected = fields.find((f) => f.id === selectedId) ?? null;
  const patchField = (id: number, patch: Partial<Field>) => setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const steps = [
    { n: 1, t: "양식", on: true, done: !!tpl },
    { n: 2, t: "영역·규격", on: !!tpl, done: fields.filter((f) => f.use).length > 0 },
    { n: 3, t: "명단", on: !!tpl, done: results.length > 0 },
    { n: 4, t: "검수·zip", on: results.length > 0, done: false },
  ];

  return (
    <div className="bulk-root" data-testid="bulk-root">
      <header className="bulk-head">
        <div className="bulk-head-in">
          <a href={`${BASE}/`} className="bulk-back">←</a>
          <span className="bulk-logo">오토한글 <b>양식 일괄 작성</b></span>
          <span className="bulk-sub">양식 하나 + 명단 → 사람 수만큼 완성본 zip</span>
          <span className="bulk-badge">결정론 · LLM 0콜 · 100% 로컬</span>
          <nav className="bulk-steps">
            {steps.map((s) => (
              <span key={s.n} className={`bulk-chip${s.on ? " on" : ""}${s.done ? " done" : ""}`}>{s.done ? "✓" : s.n} {s.t}</span>
            ))}
          </nav>
        </div>
      </header>
      <div className="bulk-wrap">
        {error && <div className="bulk-error">{error}</div>}
        {notice && <div className="bulk-notice">{notice}</div>}

        <section className="bulk-step">
          <h2><span className="num">1</span> 양식 업로드 <small>.hwp/.hwpx — 업로드 즉시 채움 영역을 자동 유도합니다</small></h2>
          <label className="bulk-btn big">
            {tpl ? `📄 ${tpl.name} · ${tpl.pages}쪽` : "＋ 양식 선택"}
            <input type="file" accept=".hwp,.hwpx" hidden data-testid="bulk-template" onChange={(e) => e.target.files?.[0] && void onTemplate(e.target.files[0])} />
          </label>
          {busy && !results.length && <span className="bulk-busy">{busy}</span>}
          {tpl && (/\.hwp$/i.test(tpl.name) ? (
            <div className="bulk-fmtnote warn" data-testid="bulk-fmt-note">
              ⚠ <b>.hwp(바이너리) 양식</b> — 산출물은 HWPX <em>변환본</em>이라 쪽 나눔·표 너비 등 서식이 원본과 달라질 수 있습니다.
              원본 서식을 그대로 보존하려면 <b>한글에서 이 양식을 &quot;.hwpx로 저장&quot; 한 파일</b>을 업로드하세요 — HWPX 양식은
              편집하지 않은 영역이 <b>바이트 단위로 보존</b>됩니다. (.hwp로 되돌리기: 산출물을 한글에서 열어 .hwp로 저장)
            </div>
          ) : (
            <div className="bulk-fmtnote ok" data-testid="bulk-fmt-note">
              ✓ <b>HWPX 양식</b> — 편집하지 않은 영역은 바이트 단위로 그대로 보존됩니다(서식 무손실). 산출물도 .hwpx입니다.
            </div>
          ))}
        </section>

        {tpl && studio && (
          <section className="bulk-step">
            <h2><span className="num">2</span> 영역 지정 · 규격화 <small>문서에서 채울 셀을 클릭 → 이름·형식 규정 → 규격 저장해 다음 배치에 재사용</small></h2>
            <div className="bulk-studio" data-testid="bulk-studio">
              <div className="bulk-studio-doc">
                <div className="bulk-nav">
                  <button onClick={() => setStudioPage((p) => Math.max(0, p - 1))} disabled={studioPage === 0}>‹</button>
                  <span className="pg">{studioPage + 1} <em>/ {tpl.pages}</em></span>
                  <button onClick={() => setStudioPage((p) => Math.min(tpl.pages - 1, p + 1))} disabled={studioPage === tpl.pages - 1}>›</button>
                  <span className="bulk-hint">셀에 마우스를 올리면 미리보기 · 클릭 = 지정/선택</span>
                </div>
                <div className="bulk-pagewrap clickable" onClick={onStudioClick} onMouseMove={onStudioMove} onMouseLeave={() => hoverRef.current && (hoverRef.current.style.opacity = "0")}>
                  {/* 엔진측 sanitize(renderPageSvgSanitized) 경유 — R7 */}
                  <div className="bulk-page" dangerouslySetInnerHTML={{ __html: studio.svg }} />
                  <div ref={hoverRef} className="bulk-hover" />
                  {studio.overlays.map((o) => (
                    <div key={o.id} className={`bulk-hl${o.selected ? " sel" : ""}`} style={{ left: `${(o.x / studio.pageW) * 100}%`, top: `${(o.y / studio.pageH) * 100}%`, width: `${(o.w / studio.pageW) * 100}%`, height: `${(o.h / studio.pageH) * 100}%` }}>
                      <span className="tag">{o.key}</span>
                    </div>
                  ))}
                </div>
              </div>
              <aside className="bulk-fields">
                <div className="bulk-fields-head">
                  <b>채움 영역 {fields.filter((f) => f.use).length}</b>
                  <div className="bulk-spec-io">
                    <button className="bulk-btn sm" data-testid="bulk-spec-save" onClick={saveSpec} disabled={fields.filter((f) => f.use).length === 0}>규격 저장</button>
                    <label className="bulk-btn sm ghost">불러오기<input type="file" accept=".json" hidden data-testid="bulk-spec-load" onChange={(e) => e.target.files?.[0] && void loadSpec(e.target.files[0])} /></label>
                  </div>
                </div>
                <div className="bulk-fields-list">
                  {fields.length === 0 && <div className="bulk-nopreview">지정된 영역이 없습니다<br />문서의 셀을 클릭하세요</div>}
                  {fields.map((f) => {
                    const pg = pageOfBlockRef.current.get(`${f.pin.section}:${f.pin.index}`);
                    return (
                      <div key={f.id} id={`bulk-fc-${f.id}`} className={`bulk-field-card${f.id === selectedId ? " sel" : ""}${f.use ? "" : " off"}`} data-testid="bulk-field-card"
                        onClick={() => { setSelectedId(f.id); if (pg !== undefined) setStudioPage(pg); }}>
                        <div className="row1">
                          <input type="checkbox" checked={f.use} onClick={(e) => e.stopPropagation()} onChange={(e) => patchField(f.id, { use: e.target.checked })} title="이 영역 사용" />
                          <span className="editwrap" onClick={(e) => e.stopPropagation()}>
                            <input className="key" value={f.key} onChange={(e) => patchField(f.id, { key: e.target.value })} spellCheck={false} placeholder="필드 이름" title="필드 이름(명단 헤더와 매칭) — 클릭해 수정" />
                            <span className="pen">✎</span>
                          </span>
                          {f.ambiguous > 0 && <span className="warn" title={`같은 라벨이 ${f.ambiguous + 1}곳 — 문서에서 위치를 확인하세요`}>⚠</span>}
                          <button className="del" onClick={(e) => { e.stopPropagation(); setFields((fs) => fs.filter((x) => x.id !== f.id)); }} title="영역 삭제">✕</button>
                        </div>
                        <div className="row2">
                          <select value={f.specType} onClick={(e) => e.stopPropagation()} onChange={(e) => patchField(f.id, { specType: e.target.value })} title="형식 규정 — 위반 시 검수에 보고">
                            {Object.entries(SPEC_TYPES).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
                          </select>
                          <label onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={f.required} onChange={(e) => patchField(f.id, { required: e.target.checked })} /> 필수</label>
                          <code>{pg !== undefined ? `${pg + 1}쪽` : "?"} · r{f.pin.row}c{f.pin.col}</code>
                        </div>
                        {(f.example || SPEC_TYPES[f.specType]?.hint) && (
                          <div className="row3">{f.example ? `현재 값: ${f.example}` : SPEC_TYPES[f.specType].hint}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </aside>
            </div>
            {selected && <div className="bulk-selinfo">선택: <b>{selected.key}</b> — 명단에서 같은 이름의 열/키 값이 이 영역에 들어갑니다.{SPEC_TYPES[selected.specType]?.re ? ` 형식 검증: ${SPEC_TYPES[selected.specType].label}.` : ""}</div>}
            {fields.filter((f) => f.use).length > 0 && <div className="bulk-nextinfo">↓ 다음: 아래 3단계에 사람별 값을 붙여넣으면, 인원수만큼 완성본이 만들어집니다</div>}
          </section>
        )}

        {tpl && (
          <section className="bulk-step">
            <h2><span className="num">3</span> 채울 내용(명단) 붙여넣기 <small>한 사람 = 한 묶음 — 2단계에서 정한 영역 이름으로 값을 적으면 그 자리에 들어갑니다</small></h2>
            <div className="bulk-howto">
              <div className="bulk-howto-card">
                <b>🤖 AI로 정리하기 (권장)</b>
                <p>엑셀·메모·기존 문서 등 아무 형태의 원본이 있다면 — 프롬프트를 복사해 ChatGPT/Claude에 원본과 함께 붙여넣으세요. 나온 결과를 아래 칸에 그대로 붙여넣으면 됩니다.</p>
                <button className="bulk-btn sm" data-testid="bulk-ai-prompt" onClick={() => {
                  const prompt = buildAiPrompt(fields.filter((f) => f.use));
                  void navigator.clipboard.writeText(prompt).then(
                    () => setNotice("✓ AI 프롬프트가 복사됐습니다 — ChatGPT/Claude 등에 붙여넣고, 끝의 \"원본 자료\" 자리에 갖고 있는 자료를 이어 붙이세요. AI가 준 결과를 아래 칸에 붙여넣으면 됩니다."),
                    () => { setRosterText(prompt); setNotice("클립보드를 못 써서 아래 칸에 프롬프트를 넣어뒀습니다 — 복사해 쓰신 뒤 지우세요."); },
                  );
                }}>📋 AI 프롬프트 복사</button>
              </div>
              <div className="bulk-howto-card">
                <b>✍️ 직접 쓰기</b>
                <p>형식 예시를 넣고 값만 바꿔도 됩니다. 엑셀 표를 복사해 그대로 붙여넣어도 인식합니다(탭 구분).</p>
                <div className="bulk-howto-btns">
                  <button className="bulk-btn sm ghost" data-testid="bulk-roster-template" onClick={() => { setRosterText(buildRosterTemplate(fields.filter((f) => f.use))); setNotice(null); }}>형식 예시 넣기</button>
                  <label className="bulk-btn sm ghost">📂 파일 열기<input type="file" accept=".csv,.txt,.tsv,.json" hidden data-testid="bulk-roster-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readTextFile(f).then(setRosterText).catch((err) => setError(`명단 파일 읽기 실패: ${err}`)); }} /></label>
                </div>
              </div>
            </div>
            <div className="bulk-keys-strip">
              <span className="bulk-hint">이 이름들이 값의 주소입니다:</span>
              {fields.filter((f) => f.use).map((f) => (<code key={f.id} className="bulk-keychip">{f.key}{f.required ? " *" : ""}</code>))}
            </div>
            <textarea className="bulk-roster" data-testid="bulk-roster" value={rosterText} onChange={(e) => setRosterText(e.target.value)} rows={9} spellCheck={false}
              placeholder={fields.filter((f) => f.use).slice(0, 3).map((f) => `${f.key}: 값`).join("\n") + "\n\n(빈 줄로 사람 구분 — CSV/엑셀 붙여넣기/JSON도 자동 인식)"} />
            <button className="bulk-btn accent big" data-testid="bulk-generate" disabled={!!busy || fields.filter((f) => f.use).length === 0 || !rosterText.trim()} onClick={() => void generate()}>
              {busy ?? `⚡ 완성본 만들기 + 검증`}
            </button>
          </section>
        )}

        {results.length > 0 && cur && (
          <section className="bulk-step">
            <h2><span className="num">4</span> 검수 <small>기준선 {baseline}쪽 · {results.length}부 중 검토 필요 {review}건 — 한 명씩 넘겨 확인 후 zip · 산출물 .hwpx(한글에서 바로 열림)</small></h2>
            <div className="bulk-nav review">
              <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>‹ 이전</button>
              <span className="bulk-idx" data-testid="bulk-idx">{idx + 1} / {results.length} — <b>{cur.name}</b>{cur.reasons.length > 0 && <em className="warn"> ⚠ {cur.reasons.join(", ")}</em>}</span>
              <button onClick={() => setIdx((i) => Math.min(results.length - 1, i + 1))} disabled={idx === results.length - 1}>다음 ›</button>
              <button className="bulk-btn accent" data-testid="bulk-zip" onClick={downloadZip}>✓ zip 다운로드 ({results.length}부 + report.json)</button>
            </div>
            <div className="bulk-review">
              <div className="bulk-doc">
                {cur.svg ? (
                  <div className="bulk-pagewrap">
                    <div className="bulk-page" dangerouslySetInnerHTML={{ __html: cur.svg }} />
                    {cur.highlights.map((h, i) => (
                      <div key={i} className="bulk-hl" style={{ left: `${(h.x / cur.pageW) * 100}%`, top: `${(h.y / cur.pageH) * 100}%`, width: `${(h.w / cur.pageW) * 100}%`, height: `${(h.h / cur.pageH) * 100}%` }} title={`${h.key}: ${h.value}`} />
                    ))}
                  </div>
                ) : (
                  <div className="bulk-nopreview">미리보기 페이지를 찾지 못했습니다(값은 report로 검증됨)</div>
                )}
              </div>
              <aside className="bulk-values" data-testid="bulk-values">
                {cur.values.map((v) => (
                  <div className="bulk-val" key={v.key}>
                    <div className="k">{v.key} <code>{v.addr}</code></div>
                    <div className="v">{v.value}</div>
                    {v.example && <div className="was">이전: {v.example}</div>}
                  </div>
                ))}
                {cur.values.length === 0 && <div className="bulk-nopreview">채운 값 없음</div>}
              </aside>
            </div>
          </section>
        )}
      </div>

      <style>{`
        body:has(.bulk-root) { background: #0a0d13; margin: 0; }
        .bulk-root { min-height: 100vh; background: radial-gradient(1200px 500px at 50% -10%, rgba(124,58,237,0.13), transparent 60%), #0a0d13; color: #dfe4ec; font-size: 14px; }
        .bulk-wrap { max-width: 1240px; margin: 0 auto; padding: 18px 20px 80px; }
        .bulk-head { position: sticky; top: 0; z-index: 20; backdrop-filter: blur(10px); background: rgba(10,13,19,0.82); border-bottom: 1px solid rgba(124,58,237,0.22); }
        .bulk-head-in { max-width: 1240px; margin: 0 auto; display: flex; align-items: center; gap: 13px; padding: 12px 20px; flex-wrap: wrap; }
        .bulk-back { text-decoration: none; color: #8b93a1; font-size: 16px; }
        .bulk-back:hover { color: #fff; }
        .bulk-logo { font-size: 15.5px; color: #a78bfa; } .bulk-logo b { color: #fff; margin-left: 2px; }
        .bulk-sub { color: #77809020; color: #78828f; font-size: 12.5px; }
        .bulk-badge { font-size: 11px; color: #a78bfa; border: 1px solid rgba(124,58,237,0.45); border-radius: 999px; padding: 3px 10px; }
        .bulk-steps { margin-left: auto; display: flex; gap: 6px; }
        .bulk-chip { font-size: 11.5px; color: #5c6470; border: 1px solid #232b3a; border-radius: 999px; padding: 4px 11px; transition: all 0.2s; }
        .bulk-chip.on { color: #c9d0da; border-color: #3a4356; }
        .bulk-chip.done { color: #6ee7b7; border-color: rgba(16,185,129,0.45); }
        .bulk-step { margin-top: 30px; }
        .bulk-step h2 { font-size: 16px; margin: 0 0 12px; display: flex; align-items: baseline; gap: 10px; color: #fff; flex-wrap: wrap; }
        .bulk-step h2 .num { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; border-radius: 7px; background: linear-gradient(135deg, #7c3aed, #a78bfa); color: #fff; font-size: 12.5px; transform: translateY(-1px); }
        .bulk-step small { color: #78828f; font-weight: 400; font-size: 12.5px; }
        .bulk-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: 10px; border: 1px solid #2b3446; cursor: pointer; background: #151b26; color: #dfe4ec; font-size: 13.5px; transition: all 0.15s; }
        .bulk-btn:hover:not(:disabled) { border-color: #7c3aed; background: #1a2130; }
        .bulk-btn.big { padding: 12px 22px; font-size: 14.5px; }
        .bulk-btn.sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }
        .bulk-btn.ghost { background: transparent; }
        .bulk-btn.accent { background: linear-gradient(135deg, #7c3aed, #6d28d9); border-color: #7c3aed; color: #fff; font-weight: 700; box-shadow: 0 4px 20px rgba(124,58,237,0.35); }
        .bulk-btn.accent:hover:not(:disabled) { box-shadow: 0 6px 26px rgba(124,58,237,0.5); transform: translateY(-1px); }
        .bulk-btn:disabled { opacity: 0.45; cursor: default; }
        .bulk-busy { margin-left: 12px; color: #a78bfa; font-size: 13px; }
        .bulk-error { margin-top: 16px; padding: 11px 15px; border-radius: 10px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.4); color: #fca5a5; }
        .bulk-notice { margin-top: 16px; padding: 11px 15px; border-radius: 10px; background: rgba(245,158,11,0.09); border: 1px solid rgba(245,158,11,0.35); color: #fcd34d; }
        .bulk-hint { color: #5c6470; font-size: 12px; }
        .bulk-studio { display: grid; grid-template-columns: 1fr 348px; gap: 18px; }
        .bulk-studio-doc { min-width: 0; }
        .bulk-nav { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; flex-wrap: wrap; }
        .bulk-nav button { padding: 6px 13px; border-radius: 8px; border: 1px solid #2b3446; background: #151b26; color: #dfe4ec; cursor: pointer; transition: all 0.15s; }
        .bulk-nav button:hover:not(:disabled) { border-color: #7c3aed; }
        .bulk-nav button:disabled { opacity: 0.35; }
        .bulk-nav .pg { font-weight: 700; color: #fff; } .bulk-nav .pg em { color: #5c6470; font-style: normal; font-weight: 400; }
        .bulk-nav.review { margin-bottom: 14px; }
        .bulk-idx { font-size: 14px; } .bulk-idx b { color: #fff; } .bulk-idx em.warn { font-weight: 400; font-style: normal; }
        .warn { color: #fbbf24; font-size: 12px; }
        .bulk-pagewrap { position: relative; border-radius: 6px; overflow: hidden; background: #fff; box-shadow: 0 14px 44px rgba(0,0,0,0.5); }
        .bulk-pagewrap.clickable { cursor: crosshair; }
        .bulk-page svg { display: block; width: 100%; height: auto; }
        .bulk-hover { position: absolute; opacity: 0; border: 1.5px dashed rgba(124,58,237,0.85); background: rgba(124,58,237,0.07); border-radius: 2px; pointer-events: none; transition: opacity 0.12s; }
        .bulk-hl { position: absolute; border: 2px solid #7c3aed; background: rgba(124,58,237,0.13); border-radius: 3px; pointer-events: none; transition: all 0.18s ease; }
        .bulk-hl.sel { border-color: #10b981; background: rgba(16,185,129,0.16); box-shadow: 0 0 16px rgba(16,185,129,0.45); }
        .bulk-hl .tag { position: absolute; top: -21px; left: -2px; font-size: 10.5px; background: #7c3aed; color: #fff; padding: 2px 8px; border-radius: 5px; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
        .bulk-hl.sel .tag { background: #10b981; color: #04110b; font-weight: 700; }
        .bulk-fields { display: flex; flex-direction: column; min-width: 0; }
        .bulk-fields-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
        .bulk-fields-head b { color: #fff; font-size: 13.5px; }
        .bulk-spec-io { display: flex; gap: 6px; }
        .bulk-fields-list { display: flex; flex-direction: column; gap: 8px; max-height: 660px; overflow: auto; padding-right: 2px; }
        .bulk-field-card { border: 1px solid #232b3a; background: #12161f; border-radius: 12px; padding: 10px 12px; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
        .bulk-field-card:hover { border-color: #3a4356; }
        .bulk-field-card.sel { border-color: #10b981; box-shadow: 0 0 0 1px #10b981, 0 4px 18px rgba(16,185,129,0.15); }
        .bulk-field-card.off { opacity: 0.45; }
        .bulk-field-card .row1 { display: flex; align-items: center; gap: 8px; }
        .bulk-field-card .editwrap { flex: 1; min-width: 0; position: relative; display: flex; }
        .bulk-field-card .key { flex: 1; min-width: 0; font-weight: 700; font-size: 13.5px; border: 1px solid #2b3446; border-radius: 8px; padding: 5px 26px 5px 9px; background: #0d1118; color: #fff; transition: border-color 0.15s; }
        .bulk-field-card .key:hover { border-color: #3a4356; }
        .bulk-field-card .key:focus { outline: none; border-color: #7c3aed; box-shadow: 0 0 0 2px rgba(124,58,237,0.25); }
        .bulk-field-card .pen { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: #5c6470; font-size: 11px; pointer-events: none; }
        .bulk-field-card .key:focus + .pen { color: #a78bfa; }
        .bulk-field-card .del { border: 0; background: none; cursor: pointer; color: #5c6470; font-size: 13px; transition: color 0.15s; }
        .bulk-field-card .del:hover { color: #f87171; }
        .bulk-field-card .row2 { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 12px; color: #8b93a1; }
        .bulk-field-card .row2 select { font-size: 12px; padding: 3px 6px; border-radius: 7px; background: #0d1118; color: #dfe4ec; border: 1px solid #2b3446; }
        .bulk-field-card .row2 label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .bulk-field-card .row2 code { margin-left: auto; font-size: 10.5px; color: #a78bfa; }
        .bulk-field-card .row3 { margin-top: 6px; font-size: 11.5px; color: #5c6470; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .bulk-selinfo { margin-top: 12px; font-size: 12.5px; color: #8b93a1; }
        .bulk-selinfo b { color: #6ee7b7; }
        .bulk-nextinfo { margin-top: 8px; font-size: 12.5px; color: #5c6470; }
        .bulk-fmtnote { margin-top: 12px; padding: 10px 14px; border-radius: 10px; font-size: 12.5px; line-height: 1.7; max-width: 780px; }
        .bulk-fmtnote.warn { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.3); color: #d9b96a; }
        .bulk-fmtnote.ok { background: rgba(16,185,129,0.07); border: 1px solid rgba(16,185,129,0.28); color: #6ee7b7; }
        .bulk-fmtnote b { color: inherit; } .bulk-fmtnote em { font-style: normal; text-decoration: underline; }
        .bulk-howto { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
        .bulk-howto-card { border: 1px solid #232b3a; background: #12161f; border-radius: 14px; padding: 14px 16px; }
        .bulk-howto-card b { color: #fff; font-size: 13.5px; }
        .bulk-howto-card p { margin: 7px 0 11px; font-size: 12.5px; color: #8b93a1; line-height: 1.65; }
        .bulk-howto-btns { display: flex; gap: 8px; flex-wrap: wrap; }
        .bulk-keys-strip { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 9px; }
        .bulk-keychip { font-size: 11.5px; color: #c4b5fd; background: rgba(124,58,237,0.13); border: 1px solid rgba(124,58,237,0.35); border-radius: 999px; padding: 3px 10px; }
        .bulk-roster-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
        .bulk-roster { width: 100%; font: 12.5px/1.7 ui-monospace, SFMono-Regular, monospace; padding: 12px 14px; border-radius: 12px; border: 1px solid #232b3a; background: #0d1118; color: #dfe4ec; box-sizing: border-box; margin-bottom: 12px; transition: border-color 0.15s; }
        .bulk-roster:focus { outline: none; border-color: #7c3aed; }
        .bulk-review { display: grid; grid-template-columns: 1fr 330px; gap: 18px; }
        .bulk-values { display: flex; flex-direction: column; gap: 10px; }
        .bulk-val { border: 1px solid #232b3a; background: #12161f; border-radius: 12px; padding: 11px 13px; }
        .bulk-val .k { font-size: 12px; color: #8b93a1; display: flex; justify-content: space-between; gap: 8px; }
        .bulk-val .k code { font-size: 10.5px; color: #a78bfa; }
        .bulk-val .v { font-weight: 700; margin-top: 5px; color: #fff; font-size: 14px; }
        .bulk-val .was { font-size: 11.5px; color: #4b5563; text-decoration: line-through; margin-top: 4px; }
        .bulk-nopreview { color: #5c6470; padding: 34px 14px; text-align: center; line-height: 1.7; border: 1px dashed #232b3a; border-radius: 12px; }
        @media (max-width: 940px) { .bulk-studio, .bulk-review { grid-template-columns: 1fr; } .bulk-steps { display: none; } }
      `}</style>
    </div>
  );
}
