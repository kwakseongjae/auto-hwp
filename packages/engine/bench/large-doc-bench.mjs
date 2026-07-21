// 대형 문서 성능 실측 (진단 U11 / 보강 F — "실측 후에만 증분 조판(XL) 착수 판단").
// 실 wasm(브라우저와 동일 바이너리)을 Node 에서 돌려 사이즈 사다리 위의 사용자 체감 비용을 잰다:
//   • open        — 파싱(rhwp 부트스트랩 포함) ms
//   • place       — 첫 전체 조판(place_doc) ms (hitTest 로 강제, placedStats 로 빌드 확인)
//   • render/p    — 페이지당 SVG 렌더 중앙값 ms (+ 전체 합)
//   • edit→screen — 편집 1회 체감: applyIntent(SetTableCell) + 재조판 강제 + page0 재렌더, 중앙값 ms
//                   (엔진은 리비전마다 전 문서를 재조판한다 — 이 수치가 U11 의 핵심)
//   • toHwpx      — 자동저장(052) 직렬화 ms
//   • rss50       — 편집 50회(undo 스냅샷 상한) 후 RSS 증가 근사 MB
// 사용:
//   node packages/engine/bench/large-doc-bench.mjs [파일.hwp|.hwpx ...]
//   --synth <N> <기반파일> : 기반 문서 끝에 (5×2 채운 표 + 문단 2) 블록을 N 회 append 한 합성
//                            대형 HWPX 를 만들어 corpus/private/bench-synth/ 에 저장 후 같이 측정.
// 인자를 생략하면 benchmarks/benchmark.hwp(8p) + benchmark1.hwp(18p)만 잰다(커밋 가능한 기본값 —
// corpus/private 실물은 로컬에서 인자로 넘긴다).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { initEngineSync, HwpDoc } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
initEngineSync({ module: readFileSync(join(here, '..', 'pkg', 'hwp_wasm_bg.wasm')) });
const fontBytes = new Uint8Array(readFileSync(join(repo, 'assets', 'fonts', 'NanumGothic-Regular.ttf')));

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const r1 = (n) => Math.round(n * 10) / 10;
const mb = (n) => r1(n / 1024 / 1024);

/** 편집 프로브 대상: 프로필의 첫 표 (0,0) — SetTableCell 의 좌표계와 동일(067). 표가 없으면 null. */
function editTarget(doc) {
  const p = doc.docProfile();
  return p.tables.length ? { section: p.tables[0].section, index: p.tables[0].block } : null;
}

function benchOne(name, bytes) {
  const t0 = performance.now();
  const doc = HwpDoc.open(bytes, name);
  const openMs = performance.now() - t0;
  doc.registerFont('bench', fontBytes); // 앱 대표 상태(랩이 open 시 나눔고딕 자동 주입)

  // 첫 전체 조판 — hitTest 가 place 를 강제한다(025 캐시 규약). placeBuilds 로 실빌드 확인.
  const b0 = doc.placedStats().placeBuilds;
  const t1 = performance.now();
  doc.hitTest(0, 120, 220);
  const placeMs = performance.now() - t1;
  const built = doc.placedStats().placeBuilds - b0;

  const pages = doc.pageCount();

  // 페이지당 SVG 렌더(초회 — 리비전 캐시 미스 경로).
  const perPage = [];
  const tR0 = performance.now();
  for (let i = 0; i < pages; i++) {
    const s = performance.now();
    doc.renderPageSvg(i);
    perPage.push(performance.now() - s);
  }
  const renderAllMs = performance.now() - tR0;

  // 편집 1회 체감 (×10 중앙값): applyIntent → 재조판 강제(hitTest) → page0 재렌더.
  const target = editTarget(doc);
  const editMs = [];
  if (target) {
    for (let i = 0; i < 10; i++) {
      const s = performance.now();
      doc.applyIntent({ intent: 'SetTableCell', section: target.section, index: target.index, row: 0, col: 0, text: `벤치${i}` });
      doc.hitTest(0, 120, 220); // 재-place 강제 (워커에서 layoutInvalidated 후 첫 쿼리에 해당)
      doc.renderPageSvg(0); // 선택적 재주입(034)의 엔진측 비용 = 편집 페이지 1장 재렌더
      editMs.push(performance.now() - s);
    }
  }

  // 자동저장 직렬화(052) — 매 편집 뒤 2s 디바운스로 도는 비용.
  const hwpxMs = [];
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    doc.toHwpx();
    hwpxMs.push(performance.now() - s);
  }

  // undo 스냅샷 메모리 근사: 편집 50회(LIVE_UNDO_LIMIT) 후 RSS 증가. GC 잡음 포함 — 근사치로만 읽는다.
  let rss50 = null;
  if (target) {
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 50; i++) {
      doc.applyIntent({ intent: 'SetTableCell', section: target.section, index: target.index, row: 0, col: 0, text: `메모리${i}` });
    }
    rss50 = process.memoryUsage().rss - before;
  }

  doc.free();
  return {
    name, pages,
    openMs: r1(openMs), placeMs: r1(placeMs), built,
    renderPageMed: r1(median(perPage)), renderAllMs: r1(renderAllMs),
    editMed: editMs.length ? r1(median(editMs)) : null,
    hwpxMed: r1(median(hwpxMs)),
    rss50Mb: rss50 == null ? null : mb(rss50),
  };
}

/** 합성 대형 문서: 기반 문서 끝에 (5×2 채운 표 + 문단 2) 를 N 회 append → HWPX 저장. 구조적으로
 *  정부양식과 같은 표-우세 구성 — 단 합성임을 파일명/보고에 정직하게 남긴다. */
function synthesize(baseBytes, baseName, copies) {
  const doc = HwpDoc.open(baseBytes, baseName);
  const row = (a, b) => [{ text: a }, { text: b }];
  const rows = [
    [{ text: '항목', bold: true }, { text: '내용', bold: true }],
    row('기업명', '벤치기업'), row('대표자', '홍길동'), row('소재지', '서울시'), row('연락처', '02-000-0000'),
  ];
  for (let i = 0; i < copies; i++) {
    doc.applyIntent({ intent: 'InsertTableAt', section: 0, index: null, rows });
    doc.applyIntent({ intent: 'InsertParagraphAt', section: 0, index: null, runs: [{ text: `합성 문단 ${i} — 사업 개요와 추진 계획을 서술한다. `.repeat(4) }] });
    doc.applyIntent({ intent: 'InsertParagraphAt', section: 0, index: null, runs: [{ text: `세부 항목 ${i}: 목표·일정·산출물. `.repeat(3) }] });
  }
  const bytes = doc.toHwpx();
  const pages = doc.pageCount();
  doc.free();
  return { bytes: new Uint8Array(bytes), pages };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const files = [];
let synth = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--synth') { synth = { copies: parseInt(argv[i + 1], 10), base: argv[i + 2] }; i += 2; }
  else files.push(argv[i]);
}
if (files.length === 0 && !synth) {
  files.push(join(repo, 'benchmarks', 'benchmark.hwp'), join(repo, 'benchmarks', 'benchmark1.hwp'));
}

const rows = [];
for (const f of files) rows.push(benchOne(basename(f), readFileSync(f)));
if (synth) {
  const baseBytes = readFileSync(synth.base);
  const s = synthesize(baseBytes, basename(synth.base), synth.copies);
  const outDir = join(repo, 'corpus', 'private', 'bench-synth');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `synth-${s.pages}p-from-${basename(synth.base).slice(0, 24)}.hwpx`);
  writeFileSync(out, s.bytes);
  console.log(`합성 문서 생성: ${out} (${s.pages}p, ${mb(s.bytes.length)}MB)`);
  rows.push(benchOne(`synth-${s.pages}p.hwpx`, s.bytes));
}

console.log('\n문서\t쪽\topen(ms)\tplace(ms)\trender/p(ms)\trenderAll(ms)\tedit→screen(ms)\ttoHwpx(ms)\trss50(MB)');
for (const r of rows) {
  if (r.built !== 1) console.log(`⚠ ${r.name}: placeBuilds=${r.built} (place 측정이 실빌드가 아님)`);
  console.log([r.name, r.pages, r.openMs, r.placeMs, r.renderPageMed, r.renderAllMs, r.editMed ?? '—', r.hwpxMed, r.rss50Mb ?? '—'].join('\t'));
}
