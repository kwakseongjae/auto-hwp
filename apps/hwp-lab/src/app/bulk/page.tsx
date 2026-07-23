"use client";
// 벌크 채움 웹 테스트 환경 (issue 073 — CLI inspect/fill의 브라우저 판).
// **전 과정 결정론 · LLM 0콜 · 100% 클라이언트**: 인스펙션(라벨→pin 초안)·채움(SetTableCell/Replace)·
// 검증(값 존재+쪽수 기준선)·검수 캐러셀(실렌더+채운 셀 하이라이트)·zip까지 엔진 API만 쓴다.
// 정적 데모(Pages)에서도 그대로 동작한다(서버 0). 규칙은 crates/auto-hwp-cli/src/fill.rs와 한 벌.
import { useCallback, useMemo, useRef, useState } from "react";
import { HwpDoc, initEngine } from "@auto-hwp/engine";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

// CLI fill.rs와 동일 렉시콘/정규화 — 두 표면이 같은 초안을 내야 한다.
const LEXICON = ["성명", "이름", "생년월일", "연락처", "전화번호", "휴대전화", "주소", "이메일", "기업명", "업체명", "회사명", "대표자", "사업자등록번호", "법인등록번호", "서명", "날짜", "작성일", "기간", "계약기간", "소속", "직위", "부서"];
const norm = (s: string) => (s || "").replace(/[\s()·:：'"※]/g, "");

interface Field {
  key: string;
  label: string;
  pin: { section: number; index: number; row: number; col: number };
  example: string;
  ambiguous: number;
  use: boolean;
  required: boolean;
}
interface RowResult {
  name: string;
  fileName: string;
  bytes: Uint8Array;
  reasons: string[];
  svg: string; // 채운 셀이 있는 페이지의 sanitized SVG
  pageW: number;
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
      const k = h.section + ':' + h.block;
      if (h.kind === 'table' && !seen.has(k)) { seen.add(k); out.push(h); }
    }
  }
  return out;
}

/** 단순 CSV(따옴표 발견 시 정직 거부 — CLI와 동일 규칙) 또는 JSON 배열 파싱. */
function parseRoster(text: string): Record<string, string>[] {
  const t = text.trim();
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as Record<string, string>[];
    if (!Array.isArray(arr)) throw new Error("JSON은 객체 배열이어야 합니다");
    return arr;
  }
  if (t.includes('"')) throw new Error("CSV에 따옴표가 있습니다 — 내장 콤마/따옴표는 JSON으로 넣어주세요");
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== header.length) throw new Error(`${i + 2}행: 열 수 ${cells.length} ≠ 헤더 ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, cells[j].trim()]));
  });
}

const SAMPLE_ROSTER = `성명,기업명,연락처
김하나,㈜하나테크,010-1111-1111
이두리,두리소프트,010-2222-2222
박세온,세온컴퍼니,010-3333-3333`;

export default function BulkFillPage() {
  const [tpl, setTpl] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [rosterText, setRosterText] = useState(SAMPLE_ROSTER);
  const [results, setResults] = useState<RowResult[]>([]);
  const [baseline, setBaseline] = useState(0);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inited = useRef(false);

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
      setResults([]);
      setBusy("양식 분석 중…");
      try {
        await ensureEngine();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = HwpDoc.open(bytes, file.name);
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
              key: label,
              label: cell.text.trim(),
              pin: { section: grid.section, index: grid.block, row: right.row, col: right.col },
              example: (right.text || "").trim(),
              ambiguous: 0,
              use: true,
              required: false,
            });
          }
        }
        for (const f of drafted) f.ambiguous = (seen.get(f.key) ?? 1) - 1;
        doc.free();
        setTpl({ bytes, name: file.name });
        setFields(drafted);
        if (drafted.length === 0) setError("라벨→값칸을 유도하지 못했습니다 — 이 양식은 수동 pin 지정이 필요합니다(후속: 화면 클릭 지정).");
      } catch (e) {
        setError(`양식 분석 실패: ${e}`);
      } finally {
        setBusy(null);
      }
    },
    [ensureEngine],
  );

  // ── 2) 생성: 인원별 채움 → 재개봉 검증 → 프리뷰 렌더+하이라이트 (전부 결정론) ────────────────
  const generate = useCallback(async () => {
    if (!tpl) return;
    setError(null);
    setBusy("생성 중…");
    try {
      await ensureEngine();
      const rows = parseRoster(rosterText);
      const active = fields.filter((f) => f.use);
      // 쪽수 기준선 = 무편집 왕복(CLI와 동일 — .hwp 템플릿의 변환 리플로를 정직 반영)
      const b0 = HwpDoc.open(tpl.bytes, tpl.name);
      const noEdit = b0.toHwpx();
      b0.free();
      const bl = HwpDoc.open(new Uint8Array(noEdit), "baseline.hwpx");
      const basePages = bl.pageCount();
      bl.free();
      setBaseline(basePages);

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
        const highlights: RowResult["highlights"] = [];
        if (filled.length) {
          // 산출물에서 채운 값의 셀을 재탐색(왕복 후 블록 인덱스 재배열을 값 스캔으로 흡수 — 073 함정 ②)
          const checkTables = allTables(check);
          let target: { section: number; block: number; row: number; col: number } | null = null;
          for (const t of checkTables) {
            const g = check.tableGrid(t.section, t.block);
            const hit = g?.cells.find((c) => c.text === filled[0].value);
            if (g && hit) {
              target = { section: g.section, block: g.block, row: hit.row, col: hit.col };
              break;
            }
          }
          for (const f of filled) {
            const found = (() => {
              for (const t of checkTables) {
                const g = check.tableGrid(t.section, t.block);
                if (g?.cells.some((c) => c.text === f.value)) return true;
              }
              return false;
            })();
            if (!found) reasons.push(`value_not_found:${f.key}`);
          }
          if (target) {
            for (let p = 0; p < pages; p++) {
              const hits = check.blocksInRect(p, 0, 0, 100000, 100000) as { section: number; block: number }[];
              if (!hits.some((h) => h.section === target!.section && h.block === target!.block)) continue;
              svg = check.renderPageSvgSanitized(p);
              const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
              pageW = m ? parseFloat(m[1]) : 1;
              const cols = check.tableColBoundaries(p, target.section, target.block);
              const rowsB = check.tableRowBoundaries(p, target.section, target.block);
              if (cols && rowsB) {
                // 같은 표에 pin된 활성 필드들의 셀 사각형(경계 배열 → 셀 rect)
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
        const person = row[active[0]?.key] ?? row[Object.keys(row)[0]] ?? `${i + 1}`;
        out.push({
          name: String(person),
          fileName: `${String(i + 1).padStart(3, "0")}_${String(person).replace(/[/\\:*?"<>|\n]/g, "_")}.hwpx`,
          bytes,
          reasons,
          svg,
          pageW,
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
  const setField = (i: number, patch: Partial<Field>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <div className="bulk-root" data-testid="bulk-root">
      <header className="bulk-head">
        <a href={`${BASE}/`} className="bulk-back">← 오토한글</a>
        <b>벌크 채움</b>
        <span className="bulk-sub">양식 1개 + 명단 N행 → 완성본 N부 zip · <em>전 과정 결정론(LLM 0콜) · 100% 로컬</em></span>
      </header>
      {error && <div className="bulk-error">{error}</div>}

      <section className="bulk-step">
        <h2>1. 양식 업로드 <small>(.hwp/.hwpx — 자동 인스펙션으로 fill-map 초안 유도)</small></h2>
        <label className="bulk-btn">
          {tpl ? `양식: ${tpl.name}` : "양식 선택"}
          <input type="file" accept=".hwp,.hwpx" hidden data-testid="bulk-template" onChange={(e) => e.target.files?.[0] && void onTemplate(e.target.files[0])} />
        </label>
      </section>

      {fields.length > 0 && (
        <section className="bulk-step">
          <h2>2. fill-map 검수 <small>(중복 라벨은 ⚠ — pin 주소를 확인하고 쓸 필드만 남기세요)</small></h2>
          <table className="bulk-map" data-testid="bulk-map">
            <thead><tr><th>사용</th><th>키(명단 헤더)</th><th>라벨</th><th>대상 주소(pin)</th><th>현재 값(예시)</th><th>필수</th></tr></thead>
            <tbody>
              {fields.map((f, i) => (
                <tr key={f.key} className={f.use ? "" : "off"}>
                  <td><input type="checkbox" checked={f.use} onChange={(e) => setField(i, { use: e.target.checked })} /></td>
                  <td><b>{f.key}</b>{f.ambiguous > 0 && <span className="warn" title={`같은 라벨이 ${f.ambiguous + 1}곳 — 첫 후보에 pin됨. 위치 확인 필요`}>⚠ 중복 {f.ambiguous + 1}</span>}</td>
                  <td>{f.label}</td>
                  <td><code>s{f.pin.section}·b{f.pin.index}·r{f.pin.row}c{f.pin.col}</code></td>
                  <td className="ex">{f.example || <i>빈칸</i>}</td>
                  <td><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tpl && (
        <section className="bulk-step">
          <h2>3. 명단 <small>(CSV 헤더=키 또는 JSON 배열 — 붙여넣기)</small></h2>
          <textarea className="bulk-roster" data-testid="bulk-roster" value={rosterText} onChange={(e) => setRosterText(e.target.value)} rows={6} spellCheck={false} />
          <button className="bulk-btn accent" data-testid="bulk-generate" disabled={!!busy || fields.filter((f) => f.use).length === 0} onClick={() => void generate()}>
            {busy ?? "생성 + 검증"}
          </button>
        </section>
      )}

      {results.length > 0 && cur && (
        <section className="bulk-step">
          <h2>4. 검수 <small>기준선 {baseline}쪽 · {results.length}부 중 검토 필요 {review}건</small></h2>
          <div className="bulk-nav">
            <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>‹ 이전</button>
            <span className="bulk-idx" data-testid="bulk-idx">{idx + 1} / {results.length} — {cur.name}{cur.reasons.length > 0 && <em className="warn"> ⚠ {cur.reasons.join(", ")}</em>}</span>
            <button onClick={() => setIdx((i) => Math.min(results.length - 1, i + 1))} disabled={idx === results.length - 1}>다음 ›</button>
            <button className="bulk-btn accent" data-testid="bulk-zip" onClick={downloadZip}>✓ zip 다운로드 ({results.length}부 + report.json)</button>
          </div>
          <div className="bulk-review">
            <div className="bulk-doc">
              {cur.svg ? (
                <div className="bulk-pagewrap">
                  {/* 엔진측 sanitize(renderPageSvgSanitized) 경유 — R7 */}
                  <div className="bulk-page" dangerouslySetInnerHTML={{ __html: cur.svg }} />
                  {cur.highlights.map((h, i) => (
                    <div key={i} className="bulk-hl" style={{ left: `${(h.x / cur.pageW) * 100}%`, top: `${(h.y / cur.pageW) * 100 * 0.7071}%`, width: `${(h.w / cur.pageW) * 100}%`, height: `${(h.h / cur.pageW) * 100 * 0.7071}%` }} title={`${h.key}: ${h.value}`} />
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

      <style>{`
        .bulk-root { max-width: 1100px; margin: 0 auto; padding: 20px 18px 60px; font-size: 14px; }
        .bulk-head { display: flex; align-items: baseline; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid rgba(128,128,128,0.25); }
        .bulk-head b { font-size: 20px; } .bulk-sub { color: #777; font-size: 12.5px; } .bulk-sub em { color: #7c3aed; font-style: normal; font-weight: 700; }
        .bulk-back { text-decoration: none; color: inherit; opacity: 0.7; }
        .bulk-step { margin-top: 22px; } .bulk-step h2 { font-size: 15px; margin: 0 0 10px; } .bulk-step small { color: #888; font-weight: 400; }
        .bulk-btn { display: inline-block; padding: 9px 16px; border-radius: 8px; border: 1px solid #bbb; cursor: pointer; background: #fff; font-size: 13.5px; }
        .bulk-btn.accent { background: #7c3aed; border-color: #7c3aed; color: #fff; font-weight: 700; }
        .bulk-btn:disabled { opacity: 0.5; }
        .bulk-error { margin-top: 14px; padding: 10px 14px; border-radius: 8px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.4); color: #b91c1c; }
        .bulk-map { border-collapse: collapse; width: 100%; } .bulk-map th, .bulk-map td { border: 1px solid rgba(128,128,128,0.3); padding: 6px 10px; text-align: left; font-size: 13px; }
        .bulk-map tr.off { opacity: 0.45; } .bulk-map .ex { color: #888; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .warn { color: #b45309; font-size: 11.5px; margin-left: 6px; }
        .bulk-roster { width: 100%; font: 12.5px/1.6 ui-monospace, monospace; padding: 10px; border-radius: 8px; border: 1px solid #bbb; box-sizing: border-box; margin-bottom: 10px; }
        .bulk-nav { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
        .bulk-nav button { padding: 7px 13px; border-radius: 8px; border: 1px solid #bbb; background: #fff; cursor: pointer; }
        .bulk-idx { font-weight: 700; } .bulk-idx em.warn { font-weight: 400; }
        .bulk-review { display: grid; grid-template-columns: 1fr 320px; gap: 16px; }
        .bulk-pagewrap { position: relative; border: 1px solid rgba(128,128,128,0.35); border-radius: 4px; overflow: hidden; background: #fff; }
        .bulk-page svg { display: block; width: 100%; height: auto; }
        .bulk-hl { position: absolute; border: 2px solid #7c3aed; background: rgba(124,58,237,0.14); border-radius: 2px; box-shadow: 0 0 10px rgba(124,58,237,0.35); pointer-events: none; }
        .bulk-values { display: flex; flex-direction: column; gap: 10px; }
        .bulk-val { border: 1px solid rgba(128,128,128,0.3); border-radius: 10px; padding: 10px 12px; }
        .bulk-val .k { font-size: 12px; color: #777; display: flex; justify-content: space-between; gap: 8px; }
        .bulk-val .k code { font-size: 10.5px; color: #7c3aed; }
        .bulk-val .v { font-weight: 700; margin-top: 4px; } .bulk-val .was { font-size: 11.5px; color: #999; text-decoration: line-through; margin-top: 3px; }
        .bulk-nopreview { color: #888; padding: 30px; text-align: center; }
        @media (max-width: 800px) { .bulk-review { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
