import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentTheme,
  normalizeTheme,
  otherTheme,
  setTheme,
  storedTheme,
  systemTheme,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  toggleTheme,
} from "./theme";

// 이 스위트는 node 환경(vitest.config.ts)에서 돈다 — 테마 해석 로직은 DOM 이 아니라 "저장값 vs OS
// 설정" 규칙이므로, 필요한 최소 표면(localStorage / matchMedia / documentElement.dataset)만 세워
// 규칙 자체를 잠근다. 실제 DOM 배선(부트 스크립트 → <html data-theme> → CSS)은 e2e(theme.spec.ts)가
// 실브라우저로 검증한다.
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

  it("명시 선택이 없으면 OS 설정을 따른다", () => {
    fakeEnv(true);
    expect(systemTheme()).toBe("light");
    expect(storedTheme()).toBeNull();
    expect(currentTheme()).toBe("light");

    fakeEnv(false);
    expect(currentTheme()).toBe("dark");
  });

  it("matchMedia 가 없으면 브랜드 기본(다크)", () => {
    vi.stubGlobal("window", {});
    expect(systemTheme()).toBe("dark");
  });

  it("명시 선택은 저장되고 OS 설정을 이긴다", () => {
    const { root, store } = fakeEnv(true); // OS 는 라이트
    setTheme("dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("토글은 두 값 사이만 오간다", () => {
    const { store } = fakeEnv(false);
    expect(otherTheme("dark")).toBe("light");
    expect(toggleTheme()).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("부트 스크립트는 같은 저장 키를 읽고 data-theme 을 세운다", () => {
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));

    const saved = fakeEnv(true, "dark"); // OS=라이트 · 저장=다크
    new Function(THEME_BOOT_SCRIPT)();
    expect(saved.root.dataset.theme).toBe("dark");

    const unset = fakeEnv(true); // 저장 없음 → OS
    new Function(THEME_BOOT_SCRIPT)();
    expect(unset.root.dataset.theme).toBe("light");
  });
});
