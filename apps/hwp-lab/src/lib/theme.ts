// 데모 전역 테마(라이트/다크) — 단일 소스.
//
// 규칙:
//  ① 기본값은 **라이트**다. 저장된 명시 선택이 있으면 그것이 이기고, 없으면 OS 가 다크여도 라이트로
//     연다(문서/제품 사이트 관례 — 첫 방문의 첫인상을 OS 설정이 좌우하지 않게 한다). 사용자가 토글을
//     누른 뒤에만 localStorage 에 선택이 남고, 그때부터는 그 선택만 본다(OS 는 더 이상 보지 않는다).
//  ② 진실은 `<html data-theme>` 하나뿐이다. CSS 는 `:root[data-theme="light"]` 로만 분기하고,
//     React 는 이 속성을 읽어(마운트 후) 자기 상태를 맞춘다 — 반대 방향(React → 속성)은 setTheme 뿐이다.
//  ③ 첫 페인트 전에 속성이 서 있어야 깜빡임(FOUC)이 없다 → THEME_BOOT_SCRIPT 를 <body> 첫 줄에서
//     동기 실행한다. 이 파일은 서버 컴포넌트(layout.tsx)도 import 하므로 react 의존이 없어야 한다.

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "auto-hwp:theme";
/** 같은 탭 안에서 토글 → 구독자(React)로 알리는 커스텀 이벤트. */
export const THEME_EVENT = "auto-hwp:themechange";

/** 저장된 선택이 없을 때의 화면 — OS 설정과 무관하게 라이트. */
export const DEFAULT_THEME: Theme = "light";

/** 알 수 없는 값(옛 키·손상)은 "선택 없음"으로 접는다 — 기본값(라이트)으로 폴백한다. */
export function normalizeTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function otherTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}

/** 사용자가 명시 선택한 값(없으면 null). 시크릿 모드/저장 거부는 null 로 접는다. */
export function storedTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 지금 화면에 적용된 테마 — `<html data-theme>` 이 정본. */
export function currentTheme(): Theme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  return normalizeTheme(document.documentElement.dataset.theme) ?? storedTheme() ?? DEFAULT_THEME;
}

/** 속성만 세운다(저장/알림 없음) — 다른 탭의 저장 변화를 되비추는 경로가 쓴다. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

/** 명시 선택: 속성 + localStorage + 같은 탭 구독자 알림. */
export function setTheme(theme: Theme): Theme {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 시크릿 모드/저장 거부 — 이 세션 동안만 유지된다(속성은 이미 섰다). */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
  return theme;
}

export function toggleTheme(): Theme {
  return setTheme(otherTheme(currentTheme()));
}

/** 테마 변경 구독: 같은 탭 토글 + 다른 탭 저장(storage). OS 설정은 구독하지 않는다(기본값이 고정이므로). */
export function subscribeTheme(onChange: (theme: Theme) => void): () => void {
  const emit = () => onChange(currentTheme());
  const onEvent = () => emit();
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
    applyTheme(normalizeTheme(e.newValue) ?? DEFAULT_THEME);
    emit();
  };
  window.addEventListener(THEME_EVENT, onEvent);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, onEvent);
    window.removeEventListener("storage", onStorage);
  };
}

/** <body> 첫 줄에서 동기 실행되는 부트 스크립트(첫 페인트 전 data-theme 확정 — FOUC 0). */
export const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});document.documentElement.dataset.theme=(s==="light"||s==="dark")?s:${JSON.stringify(DEFAULT_THEME)};}catch(e){document.documentElement.dataset.theme=${JSON.stringify(DEFAULT_THEME)};}})();`;
