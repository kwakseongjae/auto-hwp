#!/usr/bin/env node
// 077 게이트 — SDK production source의 bare 한국어 literal 차단.
//
// UI 문자열은 반드시 카탈로그에 있어야 한다. 컴포넌트/코어에 한글 literal을 새로 심으면 호스트가
// `messages` 로 덮을 수 없고, 그 순간 조용히 계약 밖으로 새는 문구가 하나 생긴다.
//
//   npm run i18n:gate     # 위반 시 exit 1
//   npm run i18n:list     # 전수 목록(인벤토리)
//
// 검사 대상: packages/react/src + packages/editor-core/src 의 production .ts/.tsx
//            (테스트·카탈로그 자체 제외). 검사 노드: string literal · template literal 조각 ·
//            JSX 텍스트. 주석은 검사하지 않는다(설명은 한국어로 쓰는 레포 규율 유지).
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
// SDK 표면 두 곳을 함께 본다: React 셸과, 앵커 라벨·Intent 카드를 만드는 헤드리스 코어.
const SRC_ROOTS = [join(pkgRoot, 'src'), resolve(pkgRoot, '..', 'editor-core', 'src')];
const repoRoot = resolve(pkgRoot, '..', '..');

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

// 카탈로그 자체와 테스트/데모는 한글 literal이 있어야 정상이다.
const EXCLUDED_DIRS = new Set(['__tests__', 'i18n', 'node_modules', 'dist']);
const EXCLUDED_FILES = new Set(['test-setup.ts', 'env.d.ts', 'messages.ts']);

// 번역 대상이 아닌 값(좁은 allowlist). 글꼴 이름·엔진 토큰·문서 콘텐츠 등.
// 형태: { file: 'src/…' (선택), text: '정확한 문자열' }
const ALLOWLIST = [
  // 글꼴 이름 + 한글 서체 분류 토큰(명조/고딕 …)은 시스템·문서·엔진이 쓰는 실제 식별자다.
  // 번역하면 substitute_family 매칭과 @font-face 별칭이 깨진다(077 드리프트 방지 §allowlist).
  { file: 'packages/react/src/fonts.ts' },
];

function isAllowed(relPath, text) {
  return ALLOWLIST.some(
    (rule) =>
      (rule.file === undefined || rule.file === relPath) &&
      (rule.text === undefined || rule.text === text),
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      walk(full, out);
      continue;
    }
    if (EXCLUDED_FILES.has(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function scanFile(file) {
  const relPath = relative(repoRoot, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];

  const record = (node, raw) => {
    const value = raw.trim();
    if (!value || !HANGUL.test(value)) return;
    if (isAllowed(relPath, value)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({ file: relPath, line: line + 1, column: character + 1, text: value });
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      record(node, node.text);
    } else if (ts.isJsxText(node)) {
      record(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const listMode = process.argv.includes('--list');
const files = SRC_ROOTS.flatMap((root) => walk(root)).sort();
const hits = files.flatMap(scanFile);

if (listMode) {
  for (const h of hits) {
    console.log(`${h.file}:${h.line}:${h.column}\t${JSON.stringify(h.text)}`);
  }
  console.log(`\n${hits.length} hangul literal(s) in ${files.length} production file(s).`);
  process.exit(0);
}

if (hits.length > 0) {
  console.error('i18n gate: production source에 bare 한국어 literal이 있습니다.');
  console.error('React 셸의 문자열 → packages/react/src/i18n/koKR.ts + useWorkspaceMessages().');
  console.error('헤드리스 코어의 문자열 → packages/editor-core/src/messages.ts (주입 파라미터로 받기).\n');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}:${h.column}  ${JSON.stringify(h.text)}`);
  }
  console.error(`\n총 ${hits.length}건.`);
  process.exit(1);
}

console.log(`i18n gate: OK — @auto-hwp/react + @auto-hwp/editor-core production file ${files.length}개에 bare 한국어 literal 없음.`);
