#!/usr/bin/env node
/**
 * npm 레지스트리의 공개 stable만으로 빈 소비자 프로젝트를 만든다.
 *
 * 검증 레인:
 *   1) 저장소 예제를 새 디렉터리에 복사한 Vite production build
 *   2) 최소 Next production build (client boundary + published CSS)
 *   3) Node에서 실제 benchmark.hwp 8쪽 열기/SVG/HWPX
 *   4) Bun이 설치돼 있으면 같은 engine smoke
 *
 * 로컬 workspace 링크·기존 node_modules·package-lock·빌드 산출물을 복사하지 않는다. 실패 시 temp
 * 디렉터리를 보존해 조사할 수 있고, 성공 시 `--keep`을 주면 브라우저 런타임 QA에 쓸 경로를 남긴다.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const versionArg = process.argv.find((value) => value.startsWith("--version="));
const version = versionArg?.slice("--version=".length) || "0.0.5";
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`invalid --version: ${version}`);
}

const root = mkdtempSync(path.join(os.tmpdir(), `auto-hwp-consumer-${version}-`));
const results = [];
let succeeded = false;

function write(relative, body) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

function copy(sourceRelative, targetRelative = sourceRelative) {
  const source = path.join(repoRoot, sourceRelative);
  const target = path.join(root, targetRelative);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function run(label, command, commandArgs, cwd) {
  const started = Date.now();
  process.stdout.write(`\n[fresh-consumer] ${label}\n`);
  execFileSync(command, commandArgs, {
    cwd,
    env: { ...process.env, CI: "1", REPO_DEV: "0" },
    stdio: "inherit",
  });
  results.push({ label, status: "pass", duration_ms: Date.now() - started });
}

function capture(label, command, commandArgs, cwd) {
  const started = Date.now();
  const stdout = execFileSync(command, commandArgs, {
    cwd,
    env: { ...process.env, CI: "1", REPO_DEV: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  results.push({ label, status: "pass", duration_ms: Date.now() - started });
  return stdout;
}

function installedVersion(project, packageName) {
  const packageJson = path.join(project, "node_modules", ...packageName.split("/"), "package.json");
  return JSON.parse(readFileSync(packageJson, "utf8")).version;
}

function assertRegistryPackages(project, names) {
  for (const name of names) {
    const actual = installedVersion(project, name);
    if (actual !== version) throw new Error(`${name}: expected registry ${version}, got ${actual}`);
  }
}

try {
  // Vite: 실제 공개 예제의 소스와 스크립트만 복사한다. dist/vendor/public/node_modules/lock은 제외한다.
  const viteRoot = path.join(root, "examples", "vite-embed");
  for (const relative of [
    "examples/vite-embed/package.json",
    "examples/vite-embed/index.html",
    "examples/vite-embed/tsconfig.json",
    "examples/vite-embed/vite.config.ts",
    "examples/vite-embed/src",
    "examples/vite-embed/scripts",
  ]) copy(relative);
  copy("assets/fonts", "assets/fonts");
  const vitePackage = JSON.parse(readFileSync(path.join(viteRoot, "package.json"), "utf8"));
  for (const name of ["@auto-hwp/engine", "@auto-hwp/editor-core", "@auto-hwp/ai-protocol", "@auto-hwp/react"]) {
    vitePackage.dependencies[name] = version;
  }
  write("examples/vite-embed/package.json", `${JSON.stringify(vitePackage, null, 2)}\n`);
  run("vite npm install", "npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], viteRoot);
  assertRegistryPackages(viteRoot, ["@auto-hwp/engine", "@auto-hwp/editor-core", "@auto-hwp/ai-protocol", "@auto-hwp/react"]);
  run("vite production build", "npm", ["run", "build"], viteRoot);
  for (const relative of ["dist/index.html", "dist/hwp/hwp_wasm_bg.wasm", "dist/hwp/worker.js"]) {
    if (!existsSync(path.join(viteRoot, relative))) throw new Error(`vite missing artifact: ${relative}`);
  }

  // Next: 문서의 client-boundary 패턴을 최소 앱으로 재현한다. 로컬 패키지나 레포 빌드 스크립트는 없다.
  const nextRoot = path.join(root, "next-consumer");
  write("next-consumer/package.json", `${JSON.stringify({
    name: "auto-hwp-next-consumer-smoke",
    private: true,
    version: "0.0.0",
    scripts: { build: "next build" },
    dependencies: {
      "@auto-hwp/ai-protocol": version,
      "@auto-hwp/engine": version,
      "@auto-hwp/react": version,
      next: "15.5.22",
      react: "18.3.1",
      "react-dom": "18.3.1",
    },
    devDependencies: {
      "@types/node": "^22.10.0",
      "@types/react": "^18.3.12",
      "@types/react-dom": "^18.3.1",
      typescript: "^5.6.3",
    },
  }, null, 2)}\n`);
  write("next-consumer/next.config.mjs", "export default { output: 'standalone' };\n");
  write("next-consumer/tsconfig.json", `${JSON.stringify({
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: false,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  }, null, 2)}\n`);
  write("next-consumer/next-env.d.ts", '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
  write("next-consumer/app/layout.tsx", `import "@auto-hwp/react/styles.css";\nexport default function Layout({ children }: { children: React.ReactNode }) {\n  return <html lang="ko"><body>{children}</body></html>;\n}\n`);
  write("next-consumer/app/page.tsx", `import { Editor } from "./editor";\nexport default function Page() { return <Editor />; }\n`);
  write("next-consumer/app/editor.tsx", `"use client";\nimport { useMemo, useState } from "react";\nimport { HwpWorkspace, WasmAdapter, workspacePanel, type HwpWorkspaceProps } from "@auto-hwp/react";\nimport { buildDocContext } from "@auto-hwp/ai-protocol";\n\nconst askAi: HwpWorkspaceProps["onAiRequest"] = async (instruction, anchors, context) => {\n  const body = JSON.stringify({ instruction, anchors, docContext: buildDocContext(context, anchors) });\n  if (!body) throw new Error("AI request serialization failed");\n  return []; // network-free smoke: only the public README bridge contract is typechecked here\n};\n\nexport function Editor() {\n  const adapter = useMemo(() => new WasmAdapter(), []);\n  const [document, setDocument] = useState<{ bytes: Uint8Array; name: string } | null>(null);\n  return <main style={{ height: "100vh" }}>\n    <input aria-label="HWP 파일" type="file" accept=".hwp,.hwpx" onChange={async (event) => {\n      const file = event.currentTarget.files?.[0];\n      if (file) setDocument({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });\n    }} />\n    <HwpWorkspace\n      adapter={adapter}\n      document={document}\n      enableEditing\n      onAiRequest={askAi}\n      sidePanel={workspacePanel({ onAiRequest: askAi })}\n    />\n  </main>;\n}\n`);
  run("next npm install", "npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], nextRoot);
  assertRegistryPackages(nextRoot, ["@auto-hwp/engine", "@auto-hwp/editor-core", "@auto-hwp/ai-protocol", "@auto-hwp/react"]);
  run("next production build", "npm", ["run", "build"], nextRoot);

  // Node/Bun: package 내부 wasm bytes를 직접 주입한다. CDN이나 브라우저 캐시를 사용하지 않는다.
  const engineRoot = path.join(root, "engine-consumer");
  write("engine-consumer/package.json", `${JSON.stringify({
    name: "auto-hwp-engine-consumer-smoke",
    private: true,
    version: "0.0.0",
    type: "module",
    dependencies: { "@auto-hwp/engine": version },
  }, null, 2)}\n`);
  copy("benchmarks/benchmark.hwp", "engine-consumer/benchmark.hwp");
  write("engine-consumer/smoke.mjs", `import { readFile } from "node:fs/promises";\nimport { createRequire } from "node:module";\nimport { HwpDoc, initEngine } from "@auto-hwp/engine";\nconst require = createRequire(import.meta.url);\nawait initEngine(await readFile(require.resolve("@auto-hwp/engine/pkg/hwp_wasm_bg.wasm")));\nconst doc = HwpDoc.open(new Uint8Array(await readFile("benchmark.hwp")), "benchmark.hwp");\ntry {\n  const pages = doc.pageCount();\n  const svg = doc.renderPageSvgSanitized(0);\n  const hwpx = doc.toHwpx();\n  if (pages !== 8) throw new Error(\`pageCount expected 8, got \${pages}\`);\n  if (!svg.includes("<svg")) throw new Error("sanitized SVG missing <svg");\n  if (!(hwpx instanceof Uint8Array) || hwpx.byteLength === 0) throw new Error("toHwpx returned no bytes");\n  console.log(JSON.stringify({ pages, svg_bytes: Buffer.byteLength(svg), hwpx_bytes: hwpx.byteLength }));\n} finally { doc.free(); }\n`);
  run("engine npm install", "npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], engineRoot);
  assertRegistryPackages(engineRoot, ["@auto-hwp/engine"]);
  const nodeResult = JSON.parse(capture("node engine runtime", process.execPath, ["smoke.mjs"], engineRoot).split("\n").at(-1));
  let bunResult = null;
  try {
    const bunVersion = capture("bun version", "bun", ["--version"], engineRoot);
    bunResult = {
      version: bunVersion,
      output: JSON.parse(capture("bun engine runtime", "bun", ["smoke.mjs"], engineRoot).split("\n").at(-1)),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    results.push({ label: "bun engine runtime", status: "skip", detail: "bun not installed" });
  }

  succeeded = true;
  process.stdout.write(`\n${JSON.stringify({
    schema_version: 1,
    stable_npm_version: version,
    temp_root: root,
    kept: keep,
    vite_root: viteRoot,
    next_root: nextRoot,
    engine_root: engineRoot,
    node: { version: process.version, output: nodeResult },
    bun: bunResult,
    results,
  }, null, 2)}\n`);
} finally {
  if (succeeded && !keep) rmSync(root, { recursive: true, force: true });
  else process.stderr.write(`[fresh-consumer] temp preserved: ${root}\n`);
}
