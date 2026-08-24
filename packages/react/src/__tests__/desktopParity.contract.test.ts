import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_DOCUMENTED_NOOPS,
  DESKTOP_EXPLICITLY_OFF,
  DESKTOP_INTENT_ROUTED_METHODS,
  DESKTOP_REQUIRED_METHODS,
} from "../../../editor-core/src/desktopRequired";

// Issue #64 D0 — CI contract for the shipping adapter pair. Presence / non-stub / Intent
// round-trip / generate_handler cross-check. Source-scan only: CI has no engine wasm pkg,
// so this file must not import WasmAdapter.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function rustIntentVariants(src: string): Set<string> {
  const start = src.indexOf("pub enum Intent {");
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\npub const MAX_IMAGE_BYTES", start));
  const names = new Set<string>();
  for (const m of body.matchAll(/^\s{4}([A-Z][A-Za-z0-9]+)\s*[{,]/gm)) {
    names.add(m[1]);
  }
  return names;
}

function generateHandlerCommands(src: string): Set<string> {
  const start = src.indexOf("tauri::generate_handler![");
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  const end = src.indexOf("]", open);
  const names = new Set<string>();
  for (const line of src.slice(open + 1, end).split("\n")) {
    const ident = line.replace(/\/\/.*$/, "").replace(/,/g, " ").trim();
    if (/^[a-z][a-z0-9_]*$/.test(ident)) names.add(ident);
  }
  return names;
}

function tauriDirectCommands(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/this\.invoke(?:<[^>]+>)?\(\s*"([a-z][a-z0-9_]*)"/g)) {
    names.push(m[1]);
  }
  return names;
}

/** Pull one class method body from a TypeScript source file (brace-matched). */
function extractMethod(src: string, className: string, name: string): string | null {
  const cls = src.indexOf(`export class ${className}`);
  const slice = cls >= 0 ? src.slice(cls) : src;
  const re = new RegExp(`\\n  (?:async\\s+)?${name}\\s*\\(`);
  const m = re.exec(slice);
  if (!m) return null;
  const start = slice.indexOf("{", m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < slice.length; i++) {
    if (slice[i] === "{") depth++;
    else if (slice[i] === "}") {
      depth--;
      if (depth === 0) return slice.slice(start, i + 1);
    }
  }
  return slice.slice(start);
}

const NOOP = new Set<string>(DESKTOP_DOCUMENTED_NOOPS);

describe("desktop adapter contract (issue #64 D0)", () => {
  const wasmSrc = readRepo("packages/react/src/WasmAdapter.ts");
  const tauriSrc = readRepo("packages/react/src/TauriAdapter.ts");

  it("required methods exist on both shipping adapters and are not no-op stubs", () => {
    for (const name of DESKTOP_REQUIRED_METHODS) {
      const wasmFn = extractMethod(wasmSrc, "WasmAdapter", name);
      const tauriFn = extractMethod(tauriSrc, "TauriAdapter", name);
      expect(wasmFn, `WasmAdapter.${name} missing`).toBeTruthy();
      expect(tauriFn, `TauriAdapter.${name} missing`).toBeTruthy();
      if (NOOP.has(name)) {
        expect(wasmFn, `WasmAdapter.${name} looks empty`).toMatch(/this\./);
        continue;
      }
      expect(wasmFn, `WasmAdapter.${name} looks empty`).toMatch(/this\./);
      const tauriLive = /this\.(invoke|applyIntent)/.test(tauriFn!) || /return true/.test(tauriFn!);
      expect(tauriLive, `TauriAdapter.${name} is a silent no-op stub:\n${tauriFn}`).toBe(true);
    }
  });

  it("normalize is explicitly off on TauriAdapter (capability-off, not a missing list entry)", () => {
    for (const name of DESKTOP_EXPLICITLY_OFF) {
      expect(DESKTOP_REQUIRED_METHODS).not.toContain(name);
      expect(extractMethod(tauriSrc, "TauriAdapter", name), `TauriAdapter must omit ${name}`).toBeNull();
      expect(extractMethod(wasmSrc, "WasmAdapter", name), `WasmAdapter still has ${name}`).toBeTruthy();
    }
  });

  it("Intent-routed methods name a real hwp_mcp::Intent variant", () => {
    const variants = rustIntentVariants(readRepo("crates/hwp-mcp/src/lib.rs"));
    for (const [method, intent] of Object.entries(DESKTOP_INTENT_ROUTED_METHODS)) {
      expect(variants.has(intent), `Intent::${intent} missing from hwp-mcp enum`).toBe(true);
      expect(tauriSrc).toContain(`intent: "${intent}"`);
      expect(tauriSrc).toContain(`${method}(`);
    }
  });

  it("the 26 direct TauriAdapter invoke commands are registered in generate_handler", () => {
    const handler = generateHandlerCommands(readRepo("crates/hwp-viewer/src/lib.rs"));
    const commands = tauriDirectCommands(tauriSrc);
    expect(commands).toHaveLength(26);
    const unique = new Set(commands);
    expect(unique.size).toBe(26);
    for (const cmd of unique) {
      expect(handler.has(cmd), `${cmd} is invoked by TauriAdapter but not in generate_handler![]`).toBe(true);
    }
  });
});
