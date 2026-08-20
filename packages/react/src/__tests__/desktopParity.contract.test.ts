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
import { TauriAdapter } from "../TauriAdapter";
import { WasmAdapter } from "../WasmAdapter";

// Issue #64 D0 — CI contract for the shipping adapter pair. Presence / non-stub / Intent
// round-trip / generate_handler cross-check. Run from packages/react vitest AND from the
// build-test job's node step (without this hook the test never runs on GitHub Actions).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

function readRepo(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

function rustIntentVariants(src: string): Set<string> {
  const start = src.indexOf("pub enum Intent {");
  expect(start).toBeGreaterThan(-1);
  // Enum body ends at the first `}\n\n` after the start (next item is MAX_IMAGE_BYTES / Outcome).
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

function methodSource(cls: { prototype: object }, name: string): string {
  const fn = (cls.prototype as Record<string, unknown>)[name];
  expect(typeof fn, `${name} must exist on the adapter prototype`).toBe("function");
  return Function.prototype.toString.call(fn);
}

const NOOP = new Set<string>(DESKTOP_DOCUMENTED_NOOPS);

describe("desktop adapter contract (issue #64 D0)", () => {
  it("required methods exist on both shipping adapters and are not no-op stubs", () => {
    for (const name of DESKTOP_REQUIRED_METHODS) {
      const wasmSrc = methodSource(WasmAdapter, name);
      const tauriSrc = methodSource(TauriAdapter, name);
      if (NOOP.has(name)) {
        // Documented desktop no-ops (native font stack / session lifetime). Wasm still does real work.
        expect(wasmSrc).toMatch(/this\./);
        continue;
      }
      expect(wasmSrc, `WasmAdapter.${name} looks empty`).toMatch(/this\./);
      const tauriLive = /this\.(invoke|applyIntent)/.test(tauriSrc) || /return true/.test(tauriSrc);
      expect(tauriLive, `TauriAdapter.${name} is a silent no-op stub:\n${tauriSrc}`).toBe(true);
    }
  });

  it("normalize is explicitly off on TauriAdapter (capability-off, not a missing list entry)", () => {
    for (const name of DESKTOP_EXPLICITLY_OFF) {
      expect(DESKTOP_REQUIRED_METHODS).not.toContain(name);
      expect((TauriAdapter.prototype as Record<string, unknown>)[name]).toBeUndefined();
      expect(typeof (WasmAdapter.prototype as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("Intent-routed methods name a real hwp_mcp::Intent variant", () => {
    const variants = rustIntentVariants(readRepo("crates/hwp-mcp/src/lib.rs"));
    const tauriSrc = readRepo("packages/react/src/TauriAdapter.ts");
    for (const [method, intent] of Object.entries(DESKTOP_INTENT_ROUTED_METHODS)) {
      expect(variants.has(intent), `Intent::${intent} missing from hwp-mcp enum`).toBe(true);
      expect(tauriSrc).toContain(`intent: "${intent}"`);
      expect(tauriSrc).toContain(`${method}(`);
    }
  });

  it("the 24 direct TauriAdapter invoke commands are registered in generate_handler", () => {
    const tauriSrc = readRepo("packages/react/src/TauriAdapter.ts");
    const handler = generateHandlerCommands(readRepo("crates/hwp-viewer/src/lib.rs"));
    const commands = tauriDirectCommands(tauriSrc);
    expect(commands).toHaveLength(24);
    const unique = new Set(commands);
    expect(unique.size).toBe(24);
    for (const cmd of unique) {
      expect(handler.has(cmd), `${cmd} is invoked by TauriAdapter but not in generate_handler![]`).toBe(true);
    }
  });
});
