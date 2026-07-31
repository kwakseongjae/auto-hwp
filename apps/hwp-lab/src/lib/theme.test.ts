import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentTheme,
  DEFAULT_THEME,
  normalizeTheme,
  otherTheme,
  setTheme,
  storedTheme,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  toggleTheme,
} from "./theme";

// 이 스위트는 node 환경(vitest.config.ts)에서 돈다 — 테마 해석 로직은 DOM 이 아니라 "저장값이
// 있으면 그것, 없으면 라이트" 규칙이므로, 필요한 최소 표면(localStorage / matchMedia /
// documentElement.dataset)만 세워 규칙 자체를 잠근다. 실제 DOM 배선(부트 스크립트 →
// <html data-theme> → CSS)은 e2e(theme-light.spec.ts)가 실브라우저로 검증한다.
//
// prefersLight 를 계속 받는 이유: "OS 설정은 더 이상 기본값에 영향을 주지 않는다"가 이 스위트가
// 잠그는 핵심 규칙이라, OS 를 다크로 세워 두고도 라이트가 나오는지를 봐야 한다.
function fakeEnv(prefersLight: boolean, stored?: string) {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set(THEME_STORAGE_KEY, stored);
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const root = { dataset: {} as Record<string, string | undefined> };
  const matchMedia = (q: string) => ({ matches: q.includes("light") ? prefersLight : !prefersLight });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", { localStorage, matchMedia, dispatchEvent: () => true });
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("CustomEvent", class {});
  return { root, store };
}

afterEach(() => vi.unstubAllGlobals());

describe("theme", () => {
  it("알 수 없는 저장값은 선택 없음으로 접는다", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("sepia")).toBeNull();
    expect(normalizeTheme(null)).toBeNull();
  });

  it("기본값은 라이트다 — OS 가 다크여도 첫 방문은 라이트", () => {
    expect(DEFAULT_THEME).toBe("light");

    fakeEnv(false); // OS = 다크, 저장된 선택 없음
    expect(storedTheme()).toBeNull();
    expect(currentTheme()).toBe("light");

    fakeEnv(true); // OS = 라이트 → 당연히 라이트
    expect(currentTheme()).toBe("light");
  });

  it("손상된 저장값도 기본값(라이트)으로 접힌다", () => {
    fakeEnv(false, "sepia");
    expect(storedTheme()).toBeNull();
    expect(currentTheme()).toBe("light");
  });

  it("명시 선택은 저장되고 기본값을 이긴다", () => {
    const { root, store } = fakeEnv(true);
    setTheme("dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("저장된 다크는 OS 가 라이트여도 유지된다", () => {
    fakeEnv(true, "dark");
    expect(storedTheme()).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("토글은 두 값 사이만 오간다", () => {
    const { store } = fakeEnv(false); // OS 다크지만 시작은 라이트(기본값)
    expect(otherTheme("dark")).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(toggleTheme()).toBe("light");
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("부트 스크립트는 같은 저장 키를 읽고 data-theme 을 세운다", () => {
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));

    const saved = fakeEnv(true, "dark"); // OS=라이트 · 저장=다크 → 저장이 이긴다
    new Function(THEME_BOOT_SCRIPT)();
    expect(saved.root.dataset.theme).toBe("dark");

    const unset = fakeEnv(false); // OS=다크 · 저장 없음 → 기본값(라이트)
    new Function(THEME_BOOT_SCRIPT)();
    expect(unset.root.dataset.theme).toBe("light");
  });

  it("부트 스크립트는 localStorage 접근이 막혀도 라이트로 연다", () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    new Function(THEME_BOOT_SCRIPT)();
    expect(root.dataset.theme).toBe("light");
  });
});
