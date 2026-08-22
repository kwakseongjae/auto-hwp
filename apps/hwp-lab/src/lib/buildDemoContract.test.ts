import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemo, demoRouteHolds } from "../../scripts/build-demo.mjs";

const PAGE = fileURLToPath(new URL("../app/models/page.tsx", import.meta.url));
const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "auto-hwp-build-demo-"));
  for (const route of ["api", "models"]) {
    const dir = path.join(root, "src", "app", route);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".sentinel"), route);
  }
  mkdirSync(path.join(root, ".next"), { recursive: true });
  mkdirSync(path.join(root, "out", "models"), { recursive: true });
  writeFileSync(path.join(root, "out", "models", "index.html"), "stale local-only route");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("static demo route contract", () => {
  it("keeps the Next 15 segment config literal and server-dynamic", () => {
    const source = readFileSync(PAGE, "utf8");
    const assignment = source.match(/export const dynamic\s*=\s*([^;]+);/);

    expect(assignment?.[1].trim()).toBe('"force-dynamic"');
    expect(source).not.toMatch(/const\s+STATIC_DEMO|dynamic\s*=\s*[^;]*\?/);
    expect(source).toContain("localModelsDeniedReason(req)");
  });

  it("excludes api and local-only models, removes stale output, then restores both", () => {
    const root = fixtureRoot();
    const routes = demoRouteHolds(root);
    const execute = vi.fn((command: string, options: { env?: NodeJS.ProcessEnv }) => {
      expect(command).toBe("npm run build");
      expect(options.env?.DEMO_STATIC).toBe("1");
      for (const route of routes) {
        expect(existsSync(route.source)).toBe(false);
        expect(existsSync(route.hold)).toBe(true);
      }
      expect(existsSync(path.join(root, "out", "models", "index.html"))).toBe(false);
    });

    buildDemo({ root, execute, logger: { log: vi.fn() } });

    expect(execute).toHaveBeenCalledOnce();
    for (const route of routes) {
      expect(existsSync(route.source)).toBe(true);
      expect(existsSync(route.hold)).toBe(false);
    }
  });

  it("restores every route when the build fails", () => {
    const root = fixtureRoot();
    const routes = demoRouteHolds(root);

    expect(() =>
      buildDemo({
        root,
        execute: () => {
          throw new Error("synthetic build failure");
        },
        logger: { log: vi.fn() },
      }),
    ).toThrow("synthetic build failure");

    for (const route of routes) {
      expect(existsSync(route.source)).toBe(true);
      expect(existsSync(route.hold)).toBe(false);
    }
    expect(existsSync(path.join(root, "out"))).toBe(false);
  });

  it("fails closed and discards partial output when a held route disappears", () => {
    const root = fixtureRoot();
    const routes = demoRouteHolds(root);
    const logger = { log: vi.fn() };

    expect(() =>
      buildDemo({
        root,
        execute: () => {
          mkdirSync(path.join(root, "out"), { recursive: true });
          writeFileSync(path.join(root, "out", "partial.html"), "partial");
          rmSync(routes[1].hold, { recursive: true, force: true });
        },
        logger,
      }),
    ).toThrow("복원 실패");

    expect(logger.log).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, "out"))).toBe(false);
    expect(existsSync(routes[0].source)).toBe(true);
    expect(existsSync(routes[0].hold)).toBe(false);
    expect(existsSync(routes[1].source)).toBe(false);
    expect(existsSync(routes[1].hold)).toBe(false);
  });

  it("recovers a stale hold, but fails closed instead of overwriting a conflict", () => {
    const root = fixtureRoot();
    const [api, models] = demoRouteHolds(root);
    renameSync(api.source, api.hold);

    buildDemo({ root, execute: vi.fn(), logger: { log: vi.fn() } });
    expect(existsSync(api.source)).toBe(true);
    expect(existsSync(api.hold)).toBe(false);

    mkdirSync(models.hold, { recursive: true });
    expect(() => buildDemo({ root, execute: vi.fn(), logger: { log: vi.fn() } })).toThrow(
      "원본과 임시 보관 경로가 모두 존재합니다",
    );
    expect(readFileSync(path.join(models.source, ".sentinel"), "utf8")).toBe("models");
    expect(existsSync(models.hold)).toBe(true);
  });
});
