"use client";
// 벌크 채움 웹 테스트 환경 (issue 073 — CLI inspect/fill의 브라우저 판 + 필드 스튜디오).
// **전 과정 결정론 · LLM 0콜 · 100% 클라이언트**: 인스펙션(라벨→pin 초안)·영역 지정(문서 클릭→셀
// 결정론 매핑 + 호버 미리보기)·규정(타입/필수)·규격 저장(fillmap JSON 재사용)·채움(SetTableCell)·
// 검증(값+쪽수+형식)·검수 캐러셀(실렌더+하이라이트)·zip까지 엔진 API만 쓴다. 정적 데모에서도 동작.
// 규칙은 crates/auto-hwp-cli/src/fill.rs와 한 벌 — 스키마는 additive(autohwp.fillmap.v1 + spec).
// 호버 셀 하이라이트는 ref 직접 스타일(마우스무브당 리렌더 0). 필드 식별은 안정 id(이름 편집 중
// 리마운트로 포커스가 날아가는 함정 — 이름을 React key로 쓰지 말 것).
//
// **화면 구조 = 5단계 퍼널**(UX 재설계): ① 양식 → ② 채울 칸 → ③ 명단 → ④ 생성·검수 → ⑤ 내려받기.
// 한 번에 한 단계만 펼치고, 지나온 단계는 스테퍼의 요약(양식명·필드 수·명단 행수)으로 접힌다
// (칩 클릭 = 복귀, 이후 단계 상태는 보존). 바뀐 것은 **뷰 배치뿐** — 인스펙션·채움·검증·report
// 계약(bulkFill/bulkEngine/bulkLane/워커 경로)은 한 줄도 건드리지 않았다. 명단 파서만 순수 로직이라
// src/lib/bulkRoster.ts 로 옮겨 테스트를 붙였다(동치는 bulkRoster.test.ts 가 잠근다).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HwpDoc, initEngine, sanitizeSvg } from "@auto-hwp/engine";
import { applyDemoSpec, buildDemoRoster, DEMO_TEMPLATE, diagnoseKeys, rosterColumns, unmatchedMessage, unmatchedReasons } from "@/lib/bulkFill";
import { parseRoster, readRoster, ROSTER_FORMAT_LABEL } from "@/lib/bulkRoster";
import { baselinePages, generateBatch, renderRowPreview, type FilledValue, type FillTarget, type RowCore, type RowPreview } from "@/lib/bulkEngine";
import { createLock, MainThreadLane, WorkerLane, yieldToUi, type BulkLane } from "@/lib/bulkLane";
import { ThemeToggle } from "@/components/ThemeToggle";

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

/** 퍼널 단계 — 화면 순서·스테퍼·h2 번호의 단일 진실. */
const STEPS = [
  { n: 1, t: "양식", hint: "hwp·hwpx" },
  { n: 2, t: "채울 칸", hint: "셀 지정" },
  { n: 3, t: "명단", hint: "붙여넣기" },
  { n: 4, t: "생성·검수", hint: "한 명씩 확인" },
  { n: 5, t: "내려받기", hint: "zip·report" },
] as const;
type StepNo = 1 | 2 | 3 | 4 | 5;
/** 명단 미리보기 표에 보여줄 최대 행수(나머지는 "총 N명"으로만 알린다). */
const ROSTER_PREVIEW_ROWS = 5;

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
  values: FilledValue[];
  failed?: boolean; // 이 행만 죽음 — zip에서 빼고 report에 created:false + row_failed 사유로 남긴다
}

/** 검수 프리뷰는 **캐러셀 진입 시 lazy 생성**한다(073 2단계 ②) — N부 SVG를 전부 state에 얹던 메모리
 *  선형 증가를 없앤다. `null` = 만들어봤지만 표시할 페이지가 없음(값 없음/미발견). */
type PreviewEntry = (RowPreview & { svg: string }) | null;
/** 현재 인덱스에서 이만큼 떨어진 프리뷰만 남긴다(최대 5장) — 100부를 넘겨봐도 상수 메모리. */
const PREVIEW_KEEP = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const [step, setStep] = useState<StepNo>(1);
  const [tpl, setTpl] = useState<{ bytes: Uint8Array; name: string; sha: string; pages: number } | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [rosterText, setRosterText] = useState("");
  const [results, setResults] = useState<RowResult[]>([]);
  const [baseline, setBaseline] = useState(0);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [previews, setPreviews] = useState<Record<number, PreviewEntry>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ codes: string[]; message: string } | null>(null); // 배치 레벨 사유코드(unmatched_* — report.json 동행)
  const [dragOver, setDragOver] = useState(false);
  const [studioPage, setStudioPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  // ③ 보조 경로(AI로 명단 정리) — 기본 경로(붙여넣기)를 밀어내지 않게 접어 둔다.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPaste, setAiPaste] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState<string | null>(null); // 클립보드 거부 시 수동 복사용 폴백
  const inited = useRef(false);
  const nextId = useRef(1);
  // 스튜디오용으로 템플릿 문서를 열어둔다(렌더·클릭 매핑·오버레이 지오메트리) — 새 업로드 때 교체.
  const tplDocRef = useRef<HwpDoc | null>(null);
  const pageOfBlockRef = useRef<Map<string, number>>(new Map());
  const hoverRef = useRef<HTMLDivElement | null>(null); // 호버 셀 박스 — ref 직접 스타일(리렌더 0)

  // 생성/프리뷰 레인(073 2단계) — 기본은 워커. 스튜디오(②단계 화면)는 클릭·호버가 동기 지오메트리라
  // 계속 메인스레드 엔진을 쓰고, **무거운 배치만** 워커로 나간다.
  const laneRef = useRef<BulkLane | null>(null);
  const runLocked = useRef(createLock()).current; // 레인은 문서 1개 계약 — 생성/프리뷰를 직렬화한다

  const ensureEngine = useCallback(async () => {
    if (!inited.current) {
      await initEngine(new URL(`${BASE}/hwp/hwp_wasm_bg.wasm`, window.location.origin));
      inited.current = true;
    }
  }, []);

  /** 벌크 레인 확보(멱등). `?bulkWorker=off` = 메인스레드 폴백(BEFORE/AFTER 실측 스위치). */
  const ensureLane = useCallback(async (): Promise<BulkLane> => {
    if (!laneRef.current) {
      const wasmUrl = new URL(`${BASE}/hwp/hwp_wasm_bg.wasm`, window.location.origin);
      const useWorker = typeof Worker !== "undefined" && new URLSearchParams(window.location.search).get("bulkWorker") !== "off";
      laneRef.current = useWorker ? new WorkerLane(new URL(`${BASE}/hwp/worker.js`, window.location.origin), wasmUrl) : new MainThreadLane(wasmUrl);
    }
    await laneRef.current.ready();
    return laneRef.current;
  }, []);

  // 페이지를 떠나면 레인을 종료한다(워커 프로세스 + 열린 wasm 문서 회수).
  useEffect(() => {
    return () => {
      laneRef.current?.dispose();
      laneRef.current = null;
    };
  }, []);

  // ── ① 템플릿 업로드 → 결정론 인스펙션(fill-map 초안) ─────────────────────────────────────────
  // 유도된 필드를 그대로 돌려준다 — "샘플로 체험"이 같은 인스펙션 결과 위에 데모 규격만 씌우기 위해서
  // (하드코딩 pin을 두면 문서가 바뀔 때 조용히 어긋난다).
  const onTemplate = useCallback(
    async (file: File): Promise<Field[] | null> => {
      setError(null);
      setNotice(null);
      setResults([]);
      setPreviews({});
      setProgress(null);
      setWarnings(null);
      setSelectedId(null);
      setDownloaded(false);
      setBusy("양식 분석 중…");
      try {
        await ensureEngine();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const replacing = !!tplDocRef.current; // 양식 교체 = 이후 단계(결과) 무효 — 정직하게 알린다
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
        setStep(2); // 업로드 = ① 완료 → 바로 ②(채울 칸)로 넘어간다
        if (drafted.length === 0) setNotice("자동 유도된 필드가 없습니다 — 아래 문서에서 채울 셀을 직접 클릭해 지정하세요.");
        else if (replacing) setNotice("양식을 바꿨습니다 — 채울 칸을 새 양식에서 다시 유도했고, 이전에 만든 결과는 지웠습니다(명단 글은 그대로 둡니다).");
        return drafted;
      } catch (e) {
        setError(`양식 분석 실패: ${e}`);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [ensureEngine],
  );

  /** 드롭 파일 처리 — 클릭 업로드와 같은 경로. 확장자는 정직하게 거른다(엔진 오류로 알리지 않는다). */
  const onDropTemplate = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault(); // 브라우저가 파일을 그냥 열어버리는 기본 동작 차단 — 작업 중인 배치가 날아간다
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!/\.hwpx?$/i.test(file.name)) {
        setError(`양식은 .hwp 또는 .hwpx만 됩니다 — 받은 파일: ${file.name}`);
        return;
      }
      void onTemplate(file);
    },
    [onTemplate],
  );

  /** "샘플로 체험" — 파일 없는 방문자용 원클릭: 샘플 양식 fetch → 같은 결정론 인스펙션 → 데모 규격
   *  (유도분 중 몇 개만 켜고 형식 규정) → 데모 명단 3행 프리필. **퍼널을 ①→②→③ 순서로 밟아 보여준
   *  뒤 ③에서 멈춘다** — 생성은 사용자가 직접 누르게 둔다(어느 단계에서 무엇이 정해지는지 학습). */
  const onSample = useCallback(async () => {
    setError(null);
    setBusy("샘플 양식 불러오는 중…");
    try {
      const r = await fetch(`${BASE}/samples/${DEMO_TEMPLATE.file}`);
      if (!r.ok) throw new Error(`샘플이 배치되지 않았습니다 (${r.status}) — apps/hwp-lab에서 npm run dev/build를 다시 실행하세요.`);
      const bytes = await r.arrayBuffer();
      const drafted = await onTemplate(new File([bytes], DEMO_TEMPLATE.file, { type: "application/octet-stream" })); // ①→②
      if (!drafted) return; // onTemplate가 이미 사유를 표시했다
      if (!drafted.length) return; // 유도 0(샘플 자산 교체 등) — onTemplate의 안내를 그대로 둔다
      const demo = applyDemoSpec(drafted);
      setFields(demo);
      const keys = demo.filter((f) => f.use).map((f) => f.key);
      setRosterText(buildDemoRoster(keys));
      setBusy("② 채울 칸 지정 중…");
      await sleep(700); // ②가 채워지는 화면을 잠깐 보여준다(퍼널 학습 — 어디서 무엇이 정해지는지)
      setStep(3);
      setNotice(`샘플 ${DEMO_TEMPLATE.label}으로 ①양식·②채울 칸·③명단(3명)까지 대신 밟았습니다 — 값·이름을 확인하고 “완성본 만들기”를 눌러보세요. 값·영역은 마음대로 고쳐도 됩니다.`);
    } catch (e) {
      setError(`샘플 불러오기 실패: ${e}`);
    } finally {
      setBusy(null);
    }
  }, [onTemplate]);

  // ── ② 스튜디오: 페이지 렌더 + 필드 오버레이 + 클릭→셀 결정론 매핑 ─────────────────────────────
  // 렌더는 ②를 펼치고 있을 때만 — 다른 단계에서 페이지 SVG를 만들 이유가 없다.
  const studio = useMemo(() => {
    const doc = tplDocRef.current;
    if (!tpl || !doc || step !== 2) return null;
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
  }, [tpl, step, studioPage, fields, selectedId]);

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

  // ── ④ 생성: 인원별 채움 → 재개봉 검증(값+쪽수+형식) ───────────────────────────────────────────
  // 073 2단계: 이 루프의 엔진 호출은 전부 **워커 레인**으로 나간다 — 메인스레드는 RPC 응답만 기다리므로
  // 100명 배치에서도 프레임이 멈추지 않는다(1단계의 MessageChannel yield는 리페인트만 겨우 확보했다).
  // 검수 SVG는 여기서 만들지 않는다 — 캐러셀 진입 시 lazy 렌더(아래 useEffect). 검증 3종은 그대로
  // 생성 시점에 한다(미루면 report.json이 거짓이 된다).
  const generate = useCallback(async () => {
    if (!tpl) return;
    setError(null);
    setNotice(null); // 이전 단계의 안내는 여기서 끝난다(④의 사유·경고만 남긴다)
    setWarnings(null);
    setResults([]);
    setPreviews({});
    setProgress(null);
    setDownloaded(false);
    setBusy("엔진 준비 중…");
    let partial: RowResult[] = []; // try 밖 — 중간에 접혀도 완성분은 보존한다
    try {
      const rows = parseRoster(rosterText);
      const active = fields.filter((f) => f.use);
      const dup = active.map((f) => f.key).filter((k, i, a) => a.indexOf(k) !== i);
      if (dup.length) throw new Error(`필드 이름이 중복됩니다: ${[...new Set(dup)].join(", ")} — ②단계에서 이름을 구분해 주세요`);
      setStep(4); // 명단이 읽혔다 = ③ 완료 → 진행률·검수는 ④에서 본다(④→⑤ 단방향)
      // 명단 열 ↔ 필드 키 양방향 대조 — 헤더 오타 한 글자가 "조용한 빈칸"으로 끝나지 않게 배너 +
      // report.json 사유코드(unmatched_column/unmatched_field)로 남긴다. 생성 자체는 계속 진행.
      const diag = diagnoseKeys(rosterColumns(rows), active.map((f) => f.key));
      const diagMessage = unmatchedMessage(diag);
      setWarnings(diagMessage ? { codes: unmatchedReasons(diag), message: diagMessage } : null);

      const lane = await ensureLane();
      // 형식 규정은 엔진과 무관한 순수 검사 — 레인 계약(FillTarget)에 클로저로 실어 보낸다.
      const targets: FillTarget[] = active.map((f) => ({
        key: f.key,
        pin: f.pin,
        required: f.required,
        example: f.example,
        formatError: (value: string) => {
          const spec = SPEC_TYPES[f.specType];
          return spec?.re && !spec.re.test(value) ? `${spec.label} 형식 아님: "${value}"` : null;
        },
      }));
      const nameKey = active.find((f) => f.key === "성명" || f.key === "이름")?.key ?? active[0]?.key;
      const personOf = (row: Record<string, string>, i: number) => String((nameKey && row[nameKey]) || row[Object.keys(row)[0]] || `${i + 1}`);
      const fileNameOf = (person: string, i: number) => `${String(i + 1).padStart(3, "0")}_${person.replace(/[/\\:*?"<>|\n]/g, "_")}.hwpx`;
      const toUi = (c: RowCore): RowResult => {
        const person = personOf(rows[c.index] ?? {}, c.index);
        return { name: person, fileName: fileNameOf(person, c.index), bytes: c.bytes, reasons: c.reasons, values: c.values, failed: c.failed };
      };

      // 쪽수 기준선 = 무편집 왕복(CLI와 동일 — .hwp 템플릿의 변환 리플로를 정직 반영)
      setBusy("기준선 확인 중…");
      const basePages = await runLocked(() => baselinePages(lane, tpl.bytes, tpl.name));
      setBaseline(basePages);

      setBusy("생성 중…");
      setProgress({ done: 0, total: rows.length });
      const batch = await runLocked(() =>
        generateBatch(lane, {
          templateBytes: tpl.bytes,
          templateName: tpl.name,
          targets,
          rows,
          basePages,
          onProgress: (done, total) => setProgress({ done, total }),
          // 청크 반영 — 완성분이 흘러들어오므로 배치가 중간에 접혀도 화면에 이미 남아 있다.
          onChunk: (done) => {
            partial = done.map(toUi);
            setResults(partial);
          },
          recover: () => lane.reset(), // wasm 트랩/워커 사망 → 되살리고 다음 행 계속
          beforeRow: yieldToUi,
        }),
      );
      lane.release(); // 워커측 문서만 회수(워커·wasm 인스턴스는 프리뷰용으로 살려둔다)
      const out = batch.rows.map(toUi);
      setResults(out);
      setIdx(0);
      const failed = out.filter((r) => r.failed).length;
      if (batch.aborted) setNotice(`생성이 중단됐습니다 — 완성된 ${out.length}부는 그대로 남아 있습니다.`);
      else if (failed) setNotice(`${failed}건이 생성 중 실패했습니다 — 나머지 ${out.length - failed}부는 그대로 남아 있고, 실패 행은 report.json에 row_failed로 기록됩니다.`);
    } catch (e) {
      // 배치 전체가 접힌 경우에도 이미 만든 부수는 살린다(다시 처음부터 돌리지 않아도 되게).
      if (partial.length) {
        setResults(partial);
        setIdx(0);
      } else {
        setStep(3); // 시작도 못 했으면 명단 단계로 되돌려 사유를 그 자리에서 고치게 한다
      }
      setError(`생성 실패${partial.length ? ` (완성된 ${partial.length}부는 보존)` : ""}: ${e}`);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [tpl, fields, rosterText, ensureLane, runLocked]);

  // ── 검수 프리뷰 lazy 로드(073 2단계 ②) ────────────────────────────────────────────────────────
  // 캐러셀이 보고 있는 한 부만 산출물 바이트를 다시 열어 렌더한다. 생성 중에는 레인이 배치를 돌고
  // 있으므로 건드리지 않는다(문서 1개 계약 — runLocked가 순서를 잡는다).
  useEffect(() => {
    if (busy) return;
    const row = results[idx];
    if (!row || row.failed || !row.values.length) return;
    if (previews[idx] !== undefined) return;
    let cancelled = false;
    void runLocked(async () => {
      const lane = laneRef.current;
      if (!lane || cancelled) return;
      let entry: PreviewEntry = null;
      try {
        const p = await renderRowPreview(lane, row.bytes, row.values);
        // 엔진 SVG는 문서 유래 미신뢰 출력 — 메인스레드에서 sanitize 후에만 DOM에 넣는다(R7).
        if (p) entry = { ...p, svg: sanitizeSvg(p.svg) };
      } catch {
        entry = null; // 프리뷰 실패는 산출물 품질과 무관 — 검증 결과(report)는 이미 확정돼 있다
      } finally {
        lane.release();
      }
      if (cancelled) return;
      // 현재 인덱스 주변만 남긴다 — 100부를 넘겨봐도 SVG 보유량은 상수.
      setPreviews((prev) => {
        const next: Record<number, PreviewEntry> = { [idx]: entry };
        for (const k of Object.keys(prev)) {
          const n = Number(k);
          if (n !== idx && Math.abs(n - idx) <= PREVIEW_KEEP) next[n] = prev[n];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [busy, idx, results, previews, runLocked]);

  const downloadZip = useCallback(() => {
    const created = results.filter((r) => !r.failed);
    const report = {
      template: tpl?.name,
      templateSha256: tpl?.sha,
      baselinePages: baseline,
      // 배치 레벨 경고(명단 열 ↔ 필드 키 대조) — 행 사유코드와 같은 어휘를 쓴다.
      warnings: warnings?.codes ?? [],
      rows: results.map((r) => ({ file: r.fileName, created: !r.failed, needsReview: r.reasons.length > 0, reasons: r.reasons })),
      created: created.length,
      skipped: results.length - created.length,
    };
    const blob = storeZip([
      ...created.map((r) => ({ name: r.fileName, bytes: r.bytes })),
      { name: "report.json", bytes: new TextEncoder().encode(JSON.stringify(report, null, 2)) },
    ]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "벌크채움_결과.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setDownloaded(true);
    setStep(5);
  }, [results, tpl, baseline, warnings]);

  /** "처음부터" — 명시적 사용자 요청일 때만(⑤단계 버튼). 문서·워커까지 회수한다. */
  const resetAll = useCallback(() => {
    tplDocRef.current?.free();
    tplDocRef.current = null;
    pageOfBlockRef.current = new Map();
    laneRef.current?.dispose();
    laneRef.current = null;
    setTpl(null);
    setFields([]);
    setRosterText("");
    setResults([]);
    setPreviews({});
    setProgress(null);
    setWarnings(null);
    setError(null);
    setNotice(null);
    setSelectedId(null);
    setStudioPage(0);
    setIdx(0);
    setBaseline(0);
    setDownloaded(false);
    setAiOpen(false);
    setAiPaste("");
    setAiError(null);
    setAiPrompt(null);
    setStep(1);
  }, []);

  const cur = results[idx];
  const preview = previews[idx]; // undefined = 아직 안 만듦(lazy), null = 표시할 페이지 없음
  const review = results.filter((r) => r.reasons.length > 0).length;
  const createdCount = results.filter((r) => !r.failed).length;
  const failedCount = results.length - createdCount;
  const selected = fields.find((f) => f.id === selectedId) ?? null;
  const activeFields = useMemo(() => fields.filter((f) => f.use), [fields]);
  const activeKeys = useMemo(() => activeFields.map((f) => f.key), [activeFields]);
  // 명단 라이브 파싱 — 미리보기 표·행수·형식 배지·매칭 진단이 전부 이 하나에서 나온다
  // (파싱 실패는 error 문자열로 드러난다 — "행 0개"로 뭉개지 않는다).
  const rosterView = useMemo(() => readRoster(rosterText), [rosterText]);
  const keyMatch = useMemo(() => {
    if (!rosterView.rows.length || !activeKeys.length) return null;
    return diagnoseKeys(rosterView.columns, activeKeys);
  }, [rosterView, activeKeys]);
  const patchField = (id: number, patch: Partial<Field>) => setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  // ── 퍼널 상태(스테퍼) ─────────────────────────────────────────────────────────────────────────
  const stepDone = (n: number) => (n === 1 ? !!tpl : n === 2 ? activeFields.length > 0 : n === 3 ? rosterView.rows.length > 0 : n === 4 ? results.length > 0 : downloaded);
  const stepOpen = (n: number) => (n === step ? true : n === 1 ? true : n === 2 ? !!tpl : n === 3 ? !!tpl && activeFields.length > 0 : n === 4 ? results.length > 0 : downloaded);
  /** 접힌 단계가 스테퍼에서 대신 말해 주는 요약("양식: 이름.hwpx"·"필드 N개"·"명단 N행 ✓"). */
  const stepSummary = (n: number): string | null => {
    if (n === 1) return tpl ? tpl.name : null;
    if (n === 2) return activeFields.length ? `필드 ${activeFields.length}개` : null;
    if (n === 3) return rosterView.rows.length ? `${rosterView.rows.length}행 ✓` : null;
    if (n === 4) return results.length ? `${createdCount}부${failedCount ? ` · 실패 ${failedCount}` : ""}` : null;
    return downloaded ? "zip 받음" : null;
  };
  const goStep = (n: number) => {
    if (busy || !stepOpen(n)) return;
    setError(null);
    setStep(n as StepNo);
  };

  /** ③ 보조 경로 ⑶ — AI가 준 결과를 기본 경로(명단 칸)로 합류. 형식이 안 맞으면 정직하게 거부. */
  const applyAiPaste = useCallback(() => {
    const v = readRoster(aiPaste);
    if (v.error || !v.rows.length) {
      setAiError(v.error ?? "인원을 하나도 찾지 못했습니다 — 위 형식(빈 줄로 사람 구분)대로인지 확인하세요.");
      return;
    }
    setAiError(null);
    setRosterText(aiPaste);
    setAiPaste("");
    setAiOpen(false);
    setNotice(`AI 결과에서 ${v.rows.length}명을 명단으로 옮겼습니다 — 아래 미리보기 표와 이름 매칭(✓/✕)을 확인하세요.`);
  }, [aiPaste]);

  const copyAiPrompt = useCallback(() => {
    const prompt = buildAiPrompt(activeFields);
    setAiError(null);
    void navigator.clipboard.writeText(prompt).then(
      () => {
        setAiPrompt(null);
        setNotice("✓ 프롬프트를 복사했습니다 — ChatGPT/Claude 등에 붙여넣고, 끝의 “원본 자료” 자리에 갖고 있는 자료를 이어 붙이세요.");
      },
      () => {
        setAiPrompt(prompt); // 클립보드 거부(권한/비보안 컨텍스트) — 아래 칸에서 직접 복사
        setNotice("클립보드를 쓸 수 없어 아래에 프롬프트를 펼쳤습니다 — 직접 복사해 쓰세요.");
      },
    );
  }, [activeFields]);

  const fmtNoteIsHwp = !!tpl && /\.hwp$/i.test(tpl.name);

  return (
    // 페이지 어디에 떨어뜨려도 브라우저가 파일을 열어 배치를 날려버리지 않게 기본 동작만 차단한다
    // (실제 처리는 아래 점선 드롭존에서만).
    <div className="bulk-root" data-testid="bulk-root" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
      <header className="bulk-head">
        <div className="bulk-head-in">
          <a href={`${BASE}/`} className="bulk-back">←</a>
          <span className="bulk-logo">오토한글 <b>양식 일괄 작성</b></span>
          <span className="bulk-sub">양식 하나 + 명단 → 사람 수만큼 완성본 zip</span>
          <span className="bulk-badge">결정론 · LLM 0콜 · 100% 로컬</span>
          <ThemeToggle />
        </div>
      </header>
      <div className="bulk-wrap">
        {/* 스테퍼 = 진행 지도 + 접힌 단계의 요약 칩(클릭 = 복귀, 이후 단계 상태 보존). */}
        <nav className="bulk-stepper" data-testid="bulk-stepper" aria-label="진행 단계">
          {STEPS.map((s) => {
            const done = stepDone(s.n);
            const open = stepOpen(s.n);
            const state = step === s.n ? "cur" : done ? "done" : open ? "open" : "lock";
            const summary = stepSummary(s.n);
            return (
              <button key={s.n} type="button" className={`bulk-stepitem ${state}`} data-testid={`bulk-step-${s.n}`} aria-current={step === s.n ? "step" : undefined} disabled={!open || !!busy} onClick={() => goStep(s.n)} title={open ? `${s.n}단계로` : "이전 단계를 먼저 마쳐 주세요"}>
                <span className="dot">{done && step !== s.n ? "✓" : s.n}</span>
                <span className="txt">
                  <b>{s.t}</b>
                  <small>{summary ?? s.hint}</small>
                </span>
              </button>
            );
          })}
        </nav>

        {error && <div className="bulk-error">{error}</div>}
        {notice && <div className="bulk-notice">{notice}</div>}

        {/* ── ① 양식 ─────────────────────────────────────────────────────────────────────────── */}
        {step === 1 && (
          <>
            {!tpl && (
              <section className="bulk-intro" aria-labelledby="bulk-title">
                <div className="bulk-intro-copy">
                  <span className="bulk-eyebrow">LOCAL DOCUMENT AUTOMATION</span>
                  <h1 id="bulk-title">한 번 만든 양식을<br />사람 수만큼 완성합니다.</h1>
                  <p>
                    문서에서 값이 들어갈 셀을 직접 확인하고, 엑셀 명단을 붙여넣으세요.
                    생성·형식 검증·미리보기·zip 묶음까지 파일은 브라우저 안에서 처리됩니다.
                  </p>
                  <div className="bulk-trust">
                    {STEPS.map((s, i) => (
                      <span key={s.n} className="bulk-trust-item">
                        {i > 0 && <i aria-hidden>→</i>}
                        <b>{String(s.n).padStart(2, "0")}</b> {s.t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="bulk-intro-visual" aria-hidden>
                  <div className="bulk-mini-doc">
                    <span className="bulk-mini-line wide" />
                    <span className="bulk-mini-line" />
                    <div className="bulk-mini-table">
                      <span>이름</span><b>홍길동</b>
                      <span>연락처</span><b>010-1234-5678</b>
                      <span>기업명</span><b>오토한글</b>
                    </div>
                  </div>
                  <div className="bulk-stack-card one">김민지.hwpx</div>
                  <div className="bulk-stack-card two">박서준.hwpx</div>
                  <div className="bulk-stack-card three">결과 24부.zip</div>
                </div>
              </section>
            )}

            <section className={`bulk-step bulk-upload-step${tpl ? " compact" : ""}`}>
              <h2><span className="num">1</span> 양식 <small>.hwp/.hwpx — 업로드 즉시 채울 칸을 자동 유도합니다</small></h2>
              <label className={`bulk-upload${tpl ? " has-file" : ""}${dragOver ? " over" : ""}`} data-testid="bulk-dropzone"
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
                onDrop={onDropTemplate}>
                <span className="bulk-upload-icon">{tpl ? "✓" : "↑"}</span>
                <span className="bulk-upload-copy">
                  <b>{tpl ? `${tpl.name} · ${tpl.pages}쪽` : dragOver ? "여기에 놓으세요" : "양식 파일을 끌어다 놓거나 선택하세요"}</b>
                  <small>{tpl ? "다른 파일로 바꾸거나 여기로 끌어다 놓기 — 바꾸면 이전 생성 결과는 무효가 됩니다" : ".hwp 또는 .hwpx · 파일은 서버로 업로드되지 않습니다"}</small>
                </span>
                <span className="bulk-upload-action">{tpl ? "바꾸기" : "파일 선택"}</span>
                <input type="file" accept=".hwp,.hwpx" hidden data-testid="bulk-template" onChange={(e) => e.target.files?.[0] && void onTemplate(e.target.files[0])} />
              </label>
              {!tpl && (
                <div className="bulk-sample-row">
                  <span>양식 파일이 없나요?</span>
                  <button className="bulk-btn sm" data-testid="bulk-sample" disabled={!!busy} onClick={() => void onSample()}>▶ 샘플로 체험</button>
                  <small>{DEMO_TEMPLATE.label} + 데모 명단 3명으로 ①→②→③까지 대신 밟아 드립니다</small>
                </div>
              )}
              {busy && <span className="bulk-busy">{busy}</span>}
              {tpl && (fmtNoteIsHwp ? (
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
              {tpl && (
                <div className="bulk-stepnav">
                  <button className="bulk-btn accent" data-testid="bulk-next" onClick={() => setStep(2)}>다음: 채울 칸 지정 →</button>
                </div>
              )}
            </section>
          </>
        )}

        {/* ── ② 채울 칸 ──────────────────────────────────────────────────────────────────────── */}
        {step === 2 && tpl && (
          <section className="bulk-step">
            <h2><span className="num">2</span> 채울 칸 <small>문서에서 값이 들어갈 셀을 클릭 → 이름·형식 규정 → 규격 저장해 다음 배치에 재사용</small></h2>
            {studio ? (
              <>
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
                      <b>채움 영역 {activeFields.length}</b>
                      <div className="bulk-spec-io">
                        <button className="bulk-btn sm" data-testid="bulk-spec-save" onClick={saveSpec} disabled={activeFields.length === 0}>규격 저장</button>
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
              </>
            ) : (
              <div className="bulk-nopreview">양식 페이지를 그리지 못했습니다 — ①단계에서 파일을 다시 열어 보세요.</div>
            )}
            <div className="bulk-stepnav">
              <button className="bulk-btn ghost" onClick={() => setStep(1)}>← 양식 바꾸기</button>
              <button className="bulk-btn accent" data-testid="bulk-next" disabled={activeFields.length === 0} onClick={() => setStep(3)}>
                다음: 명단 붙여넣기 → {activeFields.length > 0 && <em className="cnt">필드 {activeFields.length}개</em>}
              </button>
              {activeFields.length === 0 && <span className="bulk-hint">채울 칸을 하나 이상 지정해야 다음으로 갑니다</span>}
            </div>
          </section>
        )}

        {/* ── ③ 명단 ─────────────────────────────────────────────────────────────────────────── */}
        {step === 3 && tpl && (
          <section className="bulk-step">
            <h2><span className="num">3</span> 명단 <small>한 사람 = 한 묶음 — ②에서 정한 칸 이름으로 값을 적으면 그 자리에 들어갑니다</small></h2>

            <div className="bulk-roster-bar">
              <span className="bulk-hint">엑셀 표를 복사해 그대로 붙여넣어도 되고(탭 구분), CSV·JSON·“키: 값” 블록도 자동으로 알아봅니다.</span>
              <span className="spacer" />
              <button className="bulk-btn sm ghost" data-testid="bulk-roster-template" onClick={() => { setRosterText(buildRosterTemplate(activeFields)); setNotice(null); }}>형식 예시 넣기</button>
              <label className="bulk-btn sm ghost">📂 파일 열기<input type="file" accept=".csv,.txt,.tsv,.json" hidden data-testid="bulk-roster-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readTextFile(f).then(setRosterText).catch((err) => setError(`명단 파일 읽기 실패: ${err}`)); }} /></label>
            </div>

            <textarea className="bulk-roster" data-testid="bulk-roster" value={rosterText} onChange={(e) => setRosterText(e.target.value)} rows={9} spellCheck={false}
              placeholder={activeFields.slice(0, 3).map((f) => `${f.key}: 값`).join("\n") + "\n\n(빈 줄로 사람 구분 — CSV/엑셀 붙여넣기/JSON도 자동 인식)"} />

            {/* 읽은 결과를 즉시 되비춘다 — 무엇이 몇 명으로 읽혔는지 생성 전에 눈으로 확인. */}
            {rosterView.error && (
              <div className="bulk-fmtnote warn" data-testid="bulk-roster-error">
                ⚠ <b>명단을 읽지 못했습니다</b> — {rosterView.error}
              </div>
            )}
            {rosterView.rows.length > 0 && (
              <div className="bulk-roster-preview" data-testid="bulk-roster-preview">
                <div className="head">
                  <b>{rosterView.rows.length}명</b> 인식
                  {rosterView.format && <em>{ROSTER_FORMAT_LABEL[rosterView.format]}</em>}
                  <small>{rosterView.rows.length > ROSTER_PREVIEW_ROWS ? `앞 ${ROSTER_PREVIEW_ROWS}명만 표시` : "아래 값 그대로 문서에 들어갑니다"}</small>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th className="n">#</th>
                        {rosterView.columns.map((c) => (
                          <th key={c} className={activeKeys.includes(c) ? "ok" : "extra"} title={activeKeys.includes(c) ? "②의 채울 칸과 이름이 같습니다" : "어느 칸에도 들어가지 않습니다"}>{c}{activeKeys.includes(c) ? " ✓" : " ✕"}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rosterView.rows.slice(0, ROSTER_PREVIEW_ROWS).map((r, i) => (
                        <tr key={i}>
                          <td className="n">{i + 1}</td>
                          {rosterView.columns.map((c) => (<td key={c}>{r[c] ?? ""}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 키 칩 = 매칭 상태 표시기. 명단이 파싱되는 동안 영역 이름과 열 이름을 실시간 대조한다. */}
            <div className="bulk-keys-strip" data-testid="bulk-keys">
              <span className="bulk-hint">이 이름들이 값의 주소입니다:</span>
              {activeFields.map((f) => {
                const state = keyMatch ? (keyMatch.matched.includes(f.key) ? " ok" : " miss") : "";
                return (
                  <code key={f.id} className={`bulk-keychip${state}`} title={state === " ok" ? "명단에 같은 이름의 열이 있습니다" : state === " miss" ? "명단에 같은 이름의 열이 없습니다 — 이 영역은 빈칸으로 남습니다" : undefined}>
                    {f.key}{f.required ? " *" : ""}{state === " ok" ? " ✓" : state === " miss" ? " ✕" : ""}
                  </code>
                );
              })}
              {keyMatch?.unmatchedColumns.map((c) => (
                <code key={`x-${c}`} className="bulk-keychip extra" title="명단에만 있는 열 — 어느 영역에도 들어가지 않습니다">{c} ✕</code>
              ))}
            </div>

            {/* 보조 경로 — 기본(붙여넣기)을 밀어내지 않게 접어 두고, 열면 번호 붙은 3단계로 안내한다. */}
            <div className={`bulk-ai${aiOpen ? " open" : ""}`}>
              <button className="bulk-ai-head" data-testid="bulk-ai-toggle" aria-expanded={aiOpen} onClick={() => setAiOpen((o) => !o)}>
                <span className="ico">🤖</span>
                <span className="txt">
                  <b>AI로 명단 정리하기</b>
                  <small>원본이 엑셀·메모·기존 문서로 제각각일 때 — 외부 AI에게 형식만 맞춰 달라고 시키는 3단계(선택)</small>
                </span>
                <span className="caret" aria-hidden>{aiOpen ? "▲" : "▼"}</span>
              </button>
              {aiOpen && (
                <div className="bulk-ai-body" data-testid="bulk-ai-wizard">
                  <ol className="bulk-ai-steps">
                    <li>
                      <span className="n">1</span>
                      <div className="c">
                        <b>프롬프트 복사</b>
                        <p>②에서 정한 칸 이름·형식이 그대로 담긴 지시문을 만듭니다.</p>
                        <button className="bulk-btn sm" data-testid="bulk-ai-prompt" onClick={copyAiPrompt}>📋 AI 프롬프트 복사</button>
                        {aiPrompt && <textarea className="bulk-ai-prompt-text" data-testid="bulk-ai-prompt-text" readOnly rows={6} value={aiPrompt} onFocus={(e) => e.currentTarget.select()} />}
                        {/* 079 선행 고지: 이 경로만 유일하게 브라우저 밖으로 나간다 — 채움·검증은 계속 로컬. */}
                        <div className="bulk-pii" data-testid="bulk-pii-note">⚠ 이 방법을 쓰면 <b>명단의 개인정보가 외부 AI 서비스(ChatGPT 등)로 전송</b>됩니다 — 양식·채움·검증은 그대로 브라우저 안에서만 처리됩니다.</div>
                      </div>
                    </li>
                    <li>
                      <span className="n">2</span>
                      <div className="c">
                        <b>외부 AI에 붙여넣고 결과 복사</b>
                        <p>ChatGPT·Claude 등에 프롬프트를 붙여넣고, 맨 끝 “원본 자료” 자리에 갖고 있는 자료를 이어 붙이세요. AI가 이런 모양으로 답하면 됩니다.</p>
                        <pre className="bulk-ai-sample">{`기업명: ㈜다온소프트\n대표자: 김하나\n\n기업명: 초록마루협동조합\n대표자: 이두리`}</pre>
                      </div>
                    </li>
                    <li>
                      <span className="n">3</span>
                      <div className="c">
                        <b>결과 붙여넣기</b>
                        <p>여기 붙여넣으면 형식을 먼저 확인하고 위 명단 칸으로 합칩니다 — 이후는 붙여넣기 경로와 완전히 같습니다.</p>
                        <textarea className="bulk-ai-paste" data-testid="bulk-ai-result" rows={5} spellCheck={false} value={aiPaste} onChange={(e) => { setAiPaste(e.target.value); setAiError(null); }} placeholder="AI가 준 결과를 그대로 붙여넣으세요" />
                        <button className="bulk-btn sm" data-testid="bulk-ai-apply" disabled={!aiPaste.trim()} onClick={applyAiPaste}>↑ 명단으로 넣기</button>
                        {aiError && <div className="bulk-fmtnote warn" data-testid="bulk-ai-error">⚠ <b>명단으로 읽지 못했습니다</b> — {aiError}</div>}
                      </div>
                    </li>
                  </ol>
                </div>
              )}
            </div>

            <div className="bulk-stepnav">
              <button className="bulk-btn ghost" onClick={() => setStep(2)}>← 채울 칸</button>
              <button className="bulk-btn accent big" data-testid="bulk-generate" disabled={!!busy || activeFields.length === 0 || !rosterView.rows.length} onClick={() => void generate()}>
                {busy ? `${busy}${progress ? ` ${progress.done}/${progress.total}` : ""}` : `⚡ 완성본 만들기 + 검증${rosterView.rows.length ? ` (${rosterView.rows.length}부)` : ""}`}
              </button>
            </div>
          </section>
        )}

        {/* ── ④ 생성·검수 ────────────────────────────────────────────────────────────────────── */}
        {step === 4 && (
          <section className="bulk-step">
            <h2><span className="num">4</span> 생성·검수 <small>기준선 {baseline}쪽 · 한 명씩 넘겨 확인 — 산출물 .hwpx(한글에서 바로 열림)</small></h2>

            {/* 진행률 — 워커 경유라 배치 중에도 이 막대가 계속 움직인다(메인스레드 점유 0). */}
            {busy && progress && (
              <div className="bulk-progress" data-testid="bulk-progress" role="progressbar" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}>
                <div className="bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                <span>{progress.done} / {progress.total}부 — 생성은 워커 스레드에서 돕니다(이 화면은 계속 조작할 수 있습니다)</span>
              </div>
            )}
            {busy && !progress && <div className="bulk-nopreview">{busy}</div>}

            {warnings && (
              <div className="bulk-fmtnote warn" data-testid="bulk-unmatched">
                ⚠ <b>이름이 맞지 않는 항목이 있습니다</b> — {warnings.message}
                <br />
                <small>사유코드 {warnings.codes.join(" · ")} 는 report.json에도 남습니다.</small>
              </div>
            )}
            {results.length > 0 && failedCount > 0 && (
              <div className="bulk-fmtnote warn">
                ⚠ <b>{failedCount}건은 생성에 실패</b>했습니다 — 그 행만 격리되어 zip에서 빠지고 report.json에 <code>row_failed</code>로 남습니다. 나머지 {createdCount}부는 온전합니다.
              </div>
            )}

            {results.length > 0 && cur && (
              <>
                <div className="bulk-nav review">
                  <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>‹ 이전</button>
                  <span className="bulk-idx" data-testid="bulk-idx">{idx + 1} / {results.length} — <b>{cur.name}</b>{cur.reasons.length > 0 && <em className="warn"> ⚠ {cur.reasons.join(", ")}</em>}</span>
                  <button onClick={() => setIdx((i) => Math.min(results.length - 1, i + 1))} disabled={idx === results.length - 1}>다음 ›</button>
                </div>
                <div className="bulk-review">
                  <div className="bulk-doc">
                    {preview ? (
                      <div className="bulk-pagewrap">
                        <div className="bulk-page" dangerouslySetInnerHTML={{ __html: preview.svg }} />
                        {preview.highlights.map((h, i) => (
                          <div key={i} className="bulk-hl" style={{ left: `${(h.x / preview.pageW) * 100}%`, top: `${(h.y / preview.pageH) * 100}%`, width: `${(h.w / preview.pageW) * 100}%`, height: `${(h.h / preview.pageH) * 100}%` }} title={`${h.key}: ${h.value}`} />
                        ))}
                      </div>
                    ) : (
                      <div className="bulk-nopreview" data-testid="bulk-preview-state">
                        {cur.failed
                          ? "이 행은 생성 도중 실패했습니다 — zip에서 제외되고 report.json에 row_failed로 남습니다(나머지 부수는 그대로)"
                          : preview === null
                            ? "미리보기 페이지를 찾지 못했습니다(값은 report로 검증됨)"
                            : "미리보기를 만드는 중… (검수 화면에 들어온 부수만 렌더합니다 — 산출물·검증은 이미 끝났습니다)"}
                      </div>
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

                {/* 상시 고정 CTA — 검수를 어디까지 넘겼든 내려받기는 항상 한 번의 클릭. */}
                <div className="bulk-cta-bar" data-testid="bulk-cta">
                  <span className="bulk-badges" data-testid="bulk-badges">
                    <b className="ok">생성 {createdCount}부</b>
                    <b className={failedCount ? "bad" : "zero"}>실패 {failedCount}건</b>
                    <b className={review ? "warn" : "zero"}>경고 {review}건</b>
                    <small>report.json과 같은 집계</small>
                  </span>
                  <button className="bulk-btn ghost sm" onClick={() => setStep(3)} disabled={!!busy}>← 명단 고쳐 다시 만들기</button>
                  <button className="bulk-btn accent" data-testid="bulk-zip" onClick={downloadZip} disabled={!!busy}>⬇ zip 내려받기 ({createdCount}부 + report.json)</button>
                </div>
              </>
            )}
            {results.length === 0 && !busy && (
              <div className="bulk-nopreview">아직 만든 결과가 없습니다 — ③ 명단으로 돌아가 “완성본 만들기”를 눌러 주세요.</div>
            )}
          </section>
        )}

        {/* ── ⑤ 내려받기 ────────────────────────────────────────────────────────────────────── */}
        {step === 5 && (
          <section className="bulk-step">
            <h2><span className="num">5</span> 내려받기 <small>zip 안에 개별 .hwpx {createdCount}부 + report.json</small></h2>
            <div className="bulk-done" data-testid="bulk-done">
              <span className="mark">✓</span>
              <span className="copy">
                <b>벌크채움_결과.zip</b>
                <small>브라우저 다운로드 폴더를 확인하세요 — 개별 파일은 <b>.hwpx</b>라 한글에서 바로 열립니다.</small>
              </span>
              <span className="bulk-badges">
                <b className="ok">생성 {createdCount}부</b>
                <b className={failedCount ? "bad" : "zero"}>실패 {failedCount}건</b>
                <b className={review ? "warn" : "zero"}>경고 {review}건</b>
              </span>
            </div>

            <div className="bulk-report">
              <b>report.json에 들어 있는 것</b>
              <ul>
                <li><code>rows[]</code> — 부수별 <code>file</code> · <code>created</code> · <code>needsReview</code> · <code>reasons</code>(사유코드)</li>
                <li><code>created {createdCount}</code> · <code>skipped {failedCount}</code> — 위 배지와 같은 집계입니다</li>
                <li><code>baselinePages {baseline}</code> · <code>templateSha256</code> — 어떤 양식으로 만들었는지의 지문</li>
                {warnings && <li><code>warnings</code> — {warnings.codes.join(" · ")}</li>}
              </ul>
            </div>

            {failedCount > 0 && (
              <div className="bulk-fmtnote warn">
                ⚠ 실패 {failedCount}건은 zip에 없습니다 — 그 행만 격리되어 <code>row_failed</code>로 기록됐고, 나머지 {createdCount}부는 온전합니다.
              </div>
            )}
            {tpl && (fmtNoteIsHwp ? (
              <div className="bulk-fmtnote warn">
                ⚠ <b>.hwp 양식에서 만든 HWPX 변환본</b>입니다 — 쪽 나눔·표 너비 등 서식이 원본과 달라질 수 있습니다. 한글에서 열어 <b>.hwp로 저장</b>하면 원래 확장자로 되돌릴 수 있습니다.
              </div>
            ) : (
              <div className="bulk-fmtnote ok">
                ✓ <b>HWPX 양식</b>이라 편집하지 않은 영역은 바이트 단위로 그대로 보존됐습니다(서식 무손실).
              </div>
            ))}

            <div className="bulk-stepnav">
              <button className="bulk-btn accent" data-testid="bulk-zip-again" onClick={downloadZip}>⬇ 다시 내려받기 ({createdCount}부 + report.json)</button>
              <button className="bulk-btn ghost" onClick={() => setStep(4)}>← 검수로 돌아가기</button>
              <button className="bulk-btn ghost" data-testid="bulk-reset" onClick={resetAll}>↺ 처음부터</button>
            </div>
          </section>
        )}
      </div>

      <style>{`
        body:has(.bulk-root) { background: var(--ah-bg); margin: 0; }
        .bulk-root { min-height: 100vh; background: radial-gradient(1100px 520px at 72% -8%, var(--ah-glow-1), transparent 62%), radial-gradient(700px 420px at 8% 34%, var(--ah-glow-2), transparent 70%), var(--ah-bg); color: var(--ah-fg); font-size: 14px; }
        .bulk-wrap { max-width: 1240px; margin: 0 auto; padding: 0 20px 96px; }
        .bulk-head { position: sticky; top: 0; z-index: 30; backdrop-filter: blur(10px); background: var(--ah-bg-blur); border-bottom: 1px solid var(--ah-accent-edge); }
        .bulk-head-in { max-width: 1240px; margin: 0 auto; display: flex; align-items: center; gap: 13px; padding: 12px 20px; flex-wrap: wrap; }
        .bulk-back { text-decoration: none; color: var(--ah-muted); font-size: 16px; }
        .bulk-back:hover { color: var(--ah-fg-strong); }
        .bulk-logo { font-size: 15.5px; color: var(--ah-accent-ink); } .bulk-logo b { color: var(--ah-fg-strong); margin-left: 2px; }
        .bulk-sub { color: var(--ah-muted); font-size: 12.5px; }
        .bulk-badge { font-size: 11px; color: var(--ah-accent-ink); border: 1px solid var(--ah-accent-line); border-radius: 999px; padding: 3px 10px; margin-right: auto; }

        /* ── 퍼널 스테퍼(요약 칩 겸용) ─────────────────────────────────────────────────────── */
        .bulk-stepper { position: sticky; top: 49px; z-index: 20; display: flex; gap: 8px; margin: 0 -20px; padding: 12px 20px; background: var(--ah-bg-blur); backdrop-filter: blur(10px); border-bottom: 1px solid var(--ah-line); overflow-x: auto; }
        .bulk-stepitem { flex: 1 1 0; min-width: 132px; display: flex; align-items: center; gap: 9px; padding: 8px 12px; border: 1px solid var(--ah-line-2); border-radius: 12px; background: transparent; color: var(--ah-dim); cursor: pointer; text-align: left; font: inherit; transition: border-color .18s, background .18s, color .18s, box-shadow .18s; }
        .bulk-stepitem:disabled { cursor: default; }
        .bulk-stepitem.lock { opacity: .5; }
        .bulk-stepitem .dot { flex: 0 0 24px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; border: 1px solid var(--ah-line-3); font-size: 11.5px; font-weight: 700; }
        .bulk-stepitem .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .bulk-stepitem .txt b { font-size: 12.5px; color: inherit; }
        .bulk-stepitem .txt small { font-size: 10.5px; color: var(--ah-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 168px; }
        .bulk-stepitem.open { color: var(--ah-muted); }
        .bulk-stepitem.open:hover:not(:disabled), .bulk-stepitem.done:hover:not(:disabled) { border-color: var(--ah-accent); background: var(--ah-surface-hover); }
        .bulk-stepitem.done { color: var(--ah-fg-soft); border-color: rgba(16,185,129,.35); }
        .bulk-stepitem.done .dot { color: var(--ah-ok); border-color: rgba(16,185,129,.5); background: rgba(16,185,129,.12); }
        .bulk-stepitem.done .txt small { color: var(--ah-ok); }
        .bulk-stepitem.cur { color: var(--ah-fg-strong); border-color: var(--ah-accent); background: var(--ah-accent-wash); box-shadow: 0 0 0 1px var(--ah-accent-line); }
        .bulk-stepitem.cur .dot { color: #fff; border-color: transparent; background: linear-gradient(135deg, #7c3aed, #a78bfa); }
        .bulk-stepitem.cur .txt small { color: var(--ah-accent-ink-2); }

        .bulk-intro { min-height: 420px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, .82fr); gap: 58px; align-items: center; padding: 32px 34px 42px; border-bottom: 1px solid var(--ah-line); }
        .bulk-eyebrow { display: block; color: var(--ah-accent-ink); font-size: 11px; font-weight: 800; letter-spacing: .2em; margin-bottom: 17px; }
        .bulk-intro h1 { margin: 0; color: var(--ah-fg-strong); font-size: clamp(36px, 5vw, 62px); line-height: 1.08; letter-spacing: -0.045em; }
        .bulk-intro-copy > p { max-width: 630px; margin: 22px 0 0; color: var(--ah-muted); font-size: 15px; line-height: 1.8; }
        .bulk-trust { display: flex; align-items: center; gap: 10px; margin-top: 30px; flex-wrap: wrap; color: var(--ah-muted); font-size: 12px; }
        .bulk-trust-item { display: inline-flex; gap: 6px; align-items: center; }
        .bulk-trust b { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--ah-line-3); border-radius: 8px; color: var(--ah-accent-ink-2); font-size: 10px; }
        .bulk-trust i { margin-right: 4px; color: var(--ah-line-4); font-style: normal; }
        .bulk-intro-visual { position: relative; min-height: 330px; }
        .bulk-mini-doc { position: absolute; inset: 0 70px 16px 0; z-index: 3; padding: 44px 32px; border-radius: 12px; color: #172033; background: var(--ah-paper); transform: rotate(-2.5deg); box-shadow: var(--ah-shadow-doc); }
        .bulk-mini-line { display: block; width: 52%; height: 9px; margin: 0 auto 11px; border-radius: 4px; background: #172033; opacity: .9; }
        .bulk-mini-line.wide { width: 76%; height: 15px; background: linear-gradient(90deg,#7c3aed,#2563eb); }
        .bulk-mini-table { display: grid; grid-template-columns: 92px 1fr; margin-top: 46px; border: 1px solid #cbd2de; border-width: 1px 0 0 1px; }
        .bulk-mini-table > * { min-height: 36px; display: flex; align-items: center; padding: 0 9px; border: 1px solid #cbd2de; border-width: 0 1px 1px 0; font-size: 11px; }
        .bulk-mini-table span { background: #e8edfb; font-weight: 700; }
        .bulk-mini-table b { font-weight: 600; color: #38445a; }
        .bulk-stack-card { position: absolute; right: 0; width: 178px; padding: 15px 18px; border: 1px solid var(--ah-line-3); border-radius: 11px; background: var(--ah-surface-2); color: var(--ah-fg-soft); font-size: 12px; box-shadow: var(--ah-shadow-card); }
        .bulk-stack-card::before { content: "HWPX"; margin-right: 10px; color: var(--ah-accent-ink); font-size: 9px; font-weight: 800; }
        .bulk-stack-card.one { top: 72px; z-index: 4; }
        .bulk-stack-card.two { top: 132px; right: -10px; z-index: 5; }
        .bulk-stack-card.three { top: 208px; right: 10px; z-index: 6; border-color: var(--ah-accent); background: linear-gradient(135deg, var(--ah-accent-wash), var(--ah-surface-2)); color: var(--ah-fg-strong); }
        .bulk-stack-card.three::before { content: "ZIP"; color: var(--ah-ok); }
        .bulk-step { margin-top: 26px; }
        .bulk-step h2 { font-size: 16px; margin: 0 0 12px; display: flex; align-items: baseline; gap: 10px; color: var(--ah-fg-strong); flex-wrap: wrap; }
        .bulk-step h2 .num { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; border-radius: 7px; background: linear-gradient(135deg, #7c3aed, #a78bfa); color: #fff; font-size: 12.5px; transform: translateY(-1px); }
        .bulk-step small { color: var(--ah-muted); font-weight: 400; font-size: 12.5px; }
        .bulk-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: 10px; border: 1px solid var(--ah-line-3); cursor: pointer; background: var(--ah-surface-btn); color: var(--ah-fg); font-size: 13.5px; transition: all 0.15s; }
        .bulk-btn:hover:not(:disabled) { border-color: var(--ah-accent); background: var(--ah-surface-hover); }
        .bulk-btn.big { padding: 12px 22px; font-size: 14.5px; }
        .bulk-btn.sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }
        .bulk-btn.ghost { background: transparent; }
        .bulk-btn.accent { background: linear-gradient(135deg, #7c3aed, #6d28d9); border-color: #7c3aed; color: #fff; font-weight: 700; box-shadow: 0 4px 20px rgba(124,58,237,0.35); }
        .bulk-btn.accent:hover:not(:disabled) { box-shadow: 0 6px 26px rgba(124,58,237,0.5); transform: translateY(-1px); }
        .bulk-btn:disabled { opacity: 0.45; cursor: default; }
        .bulk-btn .cnt { font-style: normal; font-weight: 500; font-size: 11.5px; opacity: .85; }
        .bulk-stepnav { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--ah-line); flex-wrap: wrap; }
        .bulk-stepnav .bulk-btn.accent { margin-left: auto; }
        .bulk-stepnav .bulk-btn.accent ~ .bulk-btn, .bulk-stepnav .bulk-btn.accent ~ .bulk-hint { margin-left: 0; }
        .bulk-upload-step { max-width: 820px; margin: 26px auto 0; }
        .bulk-upload-step.compact { max-width: none; }
        .bulk-upload { min-height: 108px; display: flex; align-items: center; gap: 16px; padding: 20px 22px; border: 1px dashed var(--ah-line-4); border-radius: 18px; cursor: pointer; background: linear-gradient(135deg, var(--ah-accent-wash), transparent); transition: border-color .18s, transform .18s, background .18s; }
        .bulk-upload:hover, .bulk-upload.over { border-color: var(--ah-accent); background: linear-gradient(135deg, var(--ah-accent-wash), var(--ah-surface-hover)); transform: translateY(-1px); }
        .bulk-upload.over { border-color: var(--ah-accent-ink); box-shadow: 0 0 0 3px rgba(124,58,237,.22); }
        .bulk-upload.has-file { min-height: 74px; border-style: solid; border-color: rgba(16,185,129,.35); background: rgba(16,185,129,.055); }
        .bulk-upload-icon { display: grid; place-items: center; flex: 0 0 48px; height: 48px; border-radius: 14px; color: var(--ah-accent-ink-2); background: var(--ah-accent-wash); font-size: 23px; }
        .bulk-upload.has-file .bulk-upload-icon { color: var(--ah-ok); background: rgba(16,185,129,.14); }
        .bulk-upload-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 6px; }
        .bulk-upload-copy b { overflow: hidden; color: var(--ah-fg-strong); font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
        .bulk-upload-copy small { color: var(--ah-muted); font-size: 12px; font-weight: 400; }
        .bulk-upload-action { padding: 8px 13px; border: 1px solid var(--ah-line-4); border-radius: 9px; color: var(--ah-accent-ink-2); font-size: 12px; }
        .bulk-sample-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; color: var(--ah-muted); font-size: 12.5px; }
        .bulk-sample-row small { color: var(--ah-dim); font-size: 11.5px; }
        .bulk-busy { display: inline-block; margin-top: 10px; color: var(--ah-accent-ink); font-size: 13px; }
        .bulk-error { margin-top: 16px; padding: 11px 15px; border-radius: 10px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.4); color: var(--ah-danger); }
        .bulk-notice { margin-top: 16px; padding: 11px 15px; border-radius: 10px; background: rgba(245,158,11,0.09); border: 1px solid rgba(245,158,11,0.35); color: var(--ah-warn); }
        .bulk-hint { color: var(--ah-dim); font-size: 12px; }
        .bulk-studio { display: grid; grid-template-columns: 1fr 348px; gap: 18px; }
        .bulk-studio-doc { min-width: 0; }
        .bulk-nav { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; flex-wrap: wrap; }
        .bulk-nav button { padding: 6px 13px; border-radius: 8px; border: 1px solid var(--ah-line-3); background: var(--ah-surface-btn); color: var(--ah-fg); cursor: pointer; transition: all 0.15s; }
        .bulk-nav button:hover:not(:disabled) { border-color: var(--ah-accent); }
        .bulk-nav button:disabled { opacity: 0.35; }
        .bulk-nav .pg { font-weight: 700; color: var(--ah-fg-strong); } .bulk-nav .pg em { color: var(--ah-dim); font-style: normal; font-weight: 400; }
        .bulk-nav.review { margin-bottom: 14px; }
        .bulk-idx { font-size: 14px; } .bulk-idx b { color: var(--ah-fg-strong); } .bulk-idx em.warn { font-weight: 400; font-style: normal; }
        .warn { color: var(--ah-warn); font-size: 12px; }
        .bulk-pagewrap { position: relative; border-radius: 6px; overflow: hidden; background: var(--ah-paper); box-shadow: var(--ah-shadow-doc); }
        .bulk-pagewrap.clickable { cursor: crosshair; }
        .bulk-page svg { display: block; width: 100%; height: auto; }
        .bulk-hover { position: absolute; opacity: 0; border: 1.5px dashed rgba(124,58,237,0.85); background: rgba(124,58,237,0.07); border-radius: 2px; pointer-events: none; transition: opacity 0.12s; }
        .bulk-hl { position: absolute; border: 2px solid #7c3aed; background: rgba(124,58,237,0.13); border-radius: 3px; pointer-events: none; transition: all 0.18s ease; }
        .bulk-hl.sel { border-color: #10b981; background: rgba(16,185,129,0.16); box-shadow: 0 0 16px rgba(16,185,129,0.45); }
        .bulk-hl .tag { position: absolute; top: -21px; left: -2px; font-size: 10.5px; background: #7c3aed; color: #fff; padding: 2px 8px; border-radius: 5px; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
        .bulk-hl.sel .tag { background: #10b981; color: #04110b; font-weight: 700; }
        .bulk-fields { display: flex; flex-direction: column; min-width: 0; }
        .bulk-fields-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
        .bulk-fields-head b { color: var(--ah-fg-strong); font-size: 13.5px; }
        .bulk-spec-io { display: flex; gap: 6px; }
        .bulk-fields-list { display: flex; flex-direction: column; gap: 8px; max-height: 660px; overflow: auto; padding-right: 2px; }
        .bulk-field-card { border: 1px solid var(--ah-line-2); background: var(--ah-surface-2); border-radius: 12px; padding: 10px 12px; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
        .bulk-field-card:hover { border-color: var(--ah-line-4); }
        .bulk-field-card.sel { border-color: #10b981; box-shadow: 0 0 0 1px #10b981, 0 4px 18px rgba(16,185,129,0.15); }
        .bulk-field-card.off { opacity: 0.45; }
        .bulk-field-card .row1 { display: flex; align-items: center; gap: 8px; }
        .bulk-field-card .editwrap { flex: 1; min-width: 0; position: relative; display: flex; }
        .bulk-field-card .key { flex: 1; min-width: 0; font-weight: 700; font-size: 13.5px; border: 1px solid var(--ah-line-3); border-radius: 8px; padding: 5px 26px 5px 9px; background: var(--ah-surface-3); color: var(--ah-fg-strong); transition: border-color 0.15s; }
        .bulk-field-card .key:hover { border-color: var(--ah-line-4); }
        .bulk-field-card .key:focus { outline: none; border-color: var(--ah-accent); box-shadow: 0 0 0 2px rgba(124,58,237,0.25); }
        .bulk-field-card .pen { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--ah-dim); font-size: 11px; pointer-events: none; }
        .bulk-field-card .key:focus + .pen { color: var(--ah-accent-ink); }
        .bulk-field-card .del { border: 0; background: none; cursor: pointer; color: var(--ah-dim); font-size: 13px; transition: color 0.15s; }
        .bulk-field-card .del:hover { color: var(--ah-danger); }
        .bulk-field-card .row2 { display: flex; align-items: center; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--ah-muted); }
        .bulk-field-card .row2 select { font-size: 12px; padding: 3px 6px; border-radius: 7px; background: var(--ah-surface-3); color: var(--ah-fg); border: 1px solid var(--ah-line-3); }
        .bulk-field-card .row2 label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .bulk-field-card .row2 code { margin-left: auto; font-size: 10.5px; color: var(--ah-accent-ink); }
        .bulk-field-card .row3 { margin-top: 6px; font-size: 11.5px; color: var(--ah-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .bulk-selinfo { margin-top: 12px; font-size: 12.5px; color: var(--ah-muted); }
        .bulk-selinfo b { color: var(--ah-ok); }
        .bulk-fmtnote { margin-top: 12px; padding: 10px 14px; border-radius: 10px; font-size: 12.5px; line-height: 1.7; max-width: 880px; }
        .bulk-fmtnote.warn { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.3); color: var(--ah-warn); }
        .bulk-fmtnote.ok { background: rgba(16,185,129,0.07); border: 1px solid rgba(16,185,129,0.28); color: var(--ah-ok); }
        .bulk-fmtnote b { color: inherit; } .bulk-fmtnote em { font-style: normal; text-decoration: underline; }
        .bulk-fmtnote code { font-size: 11.5px; }

        /* ── ③ 명단 ─────────────────────────────────────────────────────────────────────── */
        .bulk-roster-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
        .bulk-roster-bar .spacer { flex: 1; }
        .bulk-roster { width: 100%; font: 12.5px/1.7 ui-monospace, SFMono-Regular, monospace; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--ah-line-2); background: var(--ah-surface-3); color: var(--ah-fg); box-sizing: border-box; transition: border-color 0.15s; }
        .bulk-roster:focus { outline: none; border-color: var(--ah-accent); }
        .bulk-roster-preview { margin-top: 12px; border: 1px solid var(--ah-line-2); border-radius: 12px; background: var(--ah-surface-2); overflow: hidden; }
        .bulk-roster-preview .head { display: flex; align-items: center; gap: 8px; padding: 9px 13px; border-bottom: 1px solid var(--ah-line-2); font-size: 12.5px; color: var(--ah-muted); flex-wrap: wrap; }
        .bulk-roster-preview .head b { color: var(--ah-ok); font-size: 13px; }
        .bulk-roster-preview .head em { font-style: normal; font-size: 11px; color: var(--ah-accent-ink-2); border: 1px solid var(--ah-accent-line); background: var(--ah-accent-wash); border-radius: 999px; padding: 2px 9px; }
        .bulk-roster-preview .head small { margin-left: auto; color: var(--ah-dim); font-size: 11.5px; }
        .bulk-roster-preview .tablewrap { overflow-x: auto; }
        .bulk-roster-preview table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .bulk-roster-preview th, .bulk-roster-preview td { padding: 7px 11px; text-align: left; border-bottom: 1px solid var(--ah-line); white-space: nowrap; }
        .bulk-roster-preview th { font-size: 11.5px; font-weight: 700; color: var(--ah-muted); background: var(--ah-surface-3); }
        .bulk-roster-preview th.ok { color: var(--ah-ok); }
        .bulk-roster-preview th.extra { color: var(--ah-danger); }
        .bulk-roster-preview td { color: var(--ah-fg-soft); }
        .bulk-roster-preview .n { width: 34px; color: var(--ah-dim); }
        .bulk-roster-preview tbody tr:last-child td { border-bottom: 0; }
        .bulk-keys-strip { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 12px; }
        .bulk-keychip { font-size: 11.5px; color: var(--ah-accent-ink-2); background: var(--ah-accent-wash); border: 1px solid var(--ah-accent-line); border-radius: 999px; padding: 3px 10px; }
        .bulk-keychip.ok { color: var(--ah-ok); background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.38); }
        .bulk-keychip.miss { color: var(--ah-warn); background: rgba(245,158,11,0.1); border-color: rgba(245,158,11,0.38); }
        .bulk-keychip.extra { color: var(--ah-danger); background: rgba(239,68,68,0.09); border-color: rgba(239,68,68,0.34); }

        /* ── ③ 보조 경로: AI 미니 위저드 ──────────────────────────────────────────────────── */
        .bulk-ai { margin-top: 16px; border: 1px solid var(--ah-line-2); border-radius: 14px; background: var(--ah-surface-2); overflow: hidden; }
        .bulk-ai.open { border-color: var(--ah-accent-line); }
        .bulk-ai-head { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 15px; border: 0; background: transparent; color: var(--ah-fg); cursor: pointer; text-align: left; font: inherit; }
        .bulk-ai-head:hover { background: var(--ah-surface-hover); }
        .bulk-ai-head .ico { font-size: 17px; }
        .bulk-ai-head .txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .bulk-ai-head .txt b { color: var(--ah-fg-strong); font-size: 13.5px; }
        .bulk-ai-head .txt small { color: var(--ah-muted); font-size: 12px; }
        .bulk-ai-head .caret { margin-left: auto; color: var(--ah-dim); font-size: 10px; }
        .bulk-ai-body { padding: 4px 15px 16px; border-top: 1px solid var(--ah-line-2); }
        .bulk-ai-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
        .bulk-ai-steps > li { display: flex; gap: 12px; padding-top: 14px; }
        .bulk-ai-steps > li .n { flex: 0 0 24px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: var(--ah-accent-wash); border: 1px solid var(--ah-accent-line); color: var(--ah-accent-ink-2); font-size: 12px; font-weight: 700; }
        .bulk-ai-steps > li .c { flex: 1; min-width: 0; }
        .bulk-ai-steps > li .c > b { display: block; color: var(--ah-fg-strong); font-size: 13px; }
        .bulk-ai-steps > li .c > p { margin: 5px 0 9px; color: var(--ah-muted); font-size: 12.5px; line-height: 1.65; }
        .bulk-ai-sample { margin: 0; padding: 10px 12px; border-radius: 9px; border: 1px dashed var(--ah-line-3); background: var(--ah-surface-3); color: var(--ah-dim); font: 11.5px/1.7 ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap; }
        .bulk-ai-paste, .bulk-ai-prompt-text { width: 100%; box-sizing: border-box; margin-bottom: 9px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--ah-line-2); background: var(--ah-surface-3); color: var(--ah-fg); font: 12px/1.65 ui-monospace, SFMono-Regular, monospace; }
        .bulk-ai-paste:focus, .bulk-ai-prompt-text:focus { outline: none; border-color: var(--ah-accent); }
        .bulk-ai-prompt-text { margin-top: 9px; }
        .bulk-pii { margin-top: 10px; font-size: 11.5px; line-height: 1.65; color: var(--ah-warn); background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.28); border-radius: 9px; padding: 8px 11px; }
        .bulk-pii b { color: inherit; }

        /* ── ④ 생성·검수 ────────────────────────────────────────────────────────────────── */
        .bulk-progress { position: relative; margin-bottom: 12px; padding: 9px 13px; border: 1px solid var(--ah-line-2); border-radius: 10px; background: var(--ah-surface-3); overflow: hidden; }
        .bulk-progress .bar { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, rgba(124,58,237,0.34), rgba(109,40,217,0.2)); transition: width 0.2s linear; }
        .bulk-progress span { position: relative; font-size: 12px; color: var(--ah-accent-ink-2); }
        .bulk-review { display: grid; grid-template-columns: 1fr 330px; gap: 18px; }
        .bulk-values { display: flex; flex-direction: column; gap: 10px; }
        .bulk-val { border: 1px solid var(--ah-line-2); background: var(--ah-surface-2); border-radius: 12px; padding: 11px 13px; }
        .bulk-val .k { font-size: 12px; color: var(--ah-muted); display: flex; justify-content: space-between; gap: 8px; }
        .bulk-val .k code { font-size: 10.5px; color: var(--ah-accent-ink); }
        .bulk-val .v { font-weight: 700; margin-top: 5px; color: var(--ah-fg-strong); font-size: 14px; }
        .bulk-val .was { font-size: 11.5px; color: var(--ah-dim); text-decoration: line-through; margin-top: 4px; }
        .bulk-nopreview { color: var(--ah-dim); padding: 34px 14px; text-align: center; line-height: 1.7; border: 1px dashed var(--ah-line-2); border-radius: 12px; }
        .bulk-cta-bar { position: sticky; bottom: 0; z-index: 15; display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 12px 16px; border: 1px solid var(--ah-accent-line); border-radius: 14px; background: var(--ah-bg-elev); backdrop-filter: blur(10px); box-shadow: var(--ah-shadow-card); flex-wrap: wrap; }
        .bulk-badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-right: auto; }
        .bulk-badges b { font-size: 12px; font-weight: 700; border-radius: 999px; padding: 4px 11px; border: 1px solid var(--ah-line-3); color: var(--ah-fg-soft); }
        .bulk-badges b.ok { color: var(--ah-ok); border-color: rgba(16,185,129,.4); background: rgba(16,185,129,.1); }
        .bulk-badges b.bad { color: var(--ah-danger); border-color: rgba(239,68,68,.4); background: rgba(239,68,68,.1); }
        .bulk-badges b.warn { color: var(--ah-warn); border-color: rgba(245,158,11,.4); background: rgba(245,158,11,.1); font-size: 12px; }
        .bulk-badges b.zero { color: var(--ah-dim); }
        .bulk-badges small { color: var(--ah-dim); font-size: 11px; }

        /* ── ⑤ 내려받기 ────────────────────────────────────────────────────────────────── */
        .bulk-done { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border: 1px solid rgba(16,185,129,.35); border-radius: 16px; background: rgba(16,185,129,.06); flex-wrap: wrap; }
        .bulk-done .mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px; background: rgba(16,185,129,.16); color: var(--ah-ok); font-size: 22px; }
        .bulk-done .copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        .bulk-done .copy b { color: var(--ah-fg-strong); font-size: 15px; }
        .bulk-done .copy small { color: var(--ah-muted); font-size: 12.5px; }
        .bulk-done .bulk-badges { margin-left: auto; margin-right: 0; }
        .bulk-report { margin-top: 16px; padding: 14px 18px; border: 1px solid var(--ah-line-2); border-radius: 14px; background: var(--ah-surface-2); max-width: 880px; }
        .bulk-report > b { color: var(--ah-fg-strong); font-size: 13.5px; }
        .bulk-report ul { margin: 9px 0 0; padding-left: 18px; color: var(--ah-muted); font-size: 12.5px; line-height: 1.9; }
        .bulk-report code { color: var(--ah-accent-ink-2); font-size: 11.5px; }

        @media (max-width: 940px) { .bulk-studio, .bulk-review, .bulk-intro { grid-template-columns: 1fr; } .bulk-intro { gap: 24px; padding-inline: 8px; } .bulk-intro-visual { min-height: 300px; } .bulk-stepitem .txt small { max-width: 110px; } }
        @media (max-width: 620px) { .bulk-wrap { padding-inline: 14px; } .bulk-sub, .bulk-badge { display: none; } .bulk-stepper { top: 45px; margin: 0 -14px; padding-inline: 14px; } .bulk-stepitem { min-width: 116px; } .bulk-intro { min-height: auto; padding-top: 22px; } .bulk-intro h1 { font-size: 38px; } .bulk-intro-visual { min-height: 250px; } .bulk-mini-doc { right: 30px; padding: 30px 20px; } .bulk-stack-card { width: 145px; } .bulk-trust i { display: none; } .bulk-upload { padding: 16px; } .bulk-upload-action { display: none; } }
      `}</style>
    </div>
  );
}
