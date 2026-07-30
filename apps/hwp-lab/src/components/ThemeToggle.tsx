"use client";

import { useEffect, useState } from "react";
import { currentTheme, subscribeTheme, toggleTheme, type Theme } from "@/lib/theme";

/// 화면 테마 토글 — 랜딩/에디터 헤더/일괄 작성/벤치가 공유하는 하나의 버튼.
///
/// ⚠️ 마크업은 **테마와 무관**하게 두 아이콘을 모두 렌더하고 어느 쪽을 보일지는 CSS
/// (`:root[data-theme]`)가 고른다. /bulk·/bench 는 서버 렌더(정적 export)되므로, 여기서 테마에 따라
/// 다른 노드를 그리면 하이드레이션 불일치가 난다(그리고 첫 프레임이 깜빡인다).
export function ThemeToggle({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={`ah-theme-toggle${className ? ` ${className}` : ""}`}
      data-testid="theme-toggle"
      title="밝은 화면 / 어두운 화면 전환"
      aria-label="화면 테마 전환"
      onClick={() => toggleTheme()}
    >
      <span className="ah-theme-ic ah-theme-ic-sun" aria-hidden>
        ☀
      </span>
      <span className="ah-theme-ic ah-theme-ic-moon" aria-hidden>
        ☾
      </span>
    </button>
  );
}

/// 현재 테마를 React 상태로 읽는다(SDK className 분기 등 CSS 로 못 푸는 곳 전용).
/// 첫 렌더는 "dark"(브랜드 기본)에서 시작하고 마운트 직후 실제 `<html data-theme>` 로 맞춘다 —
/// ssr:false 로 로드되는 곳(LabWorkspace)에서는 그 첫 렌더조차 브라우저에서 일어나므로
/// currentTheme() 이 바로 정확하다.
export function useTheme(): Theme {
  const [theme, setThemeState] = useState<Theme>(() => (typeof document === "undefined" ? "dark" : currentTheme()));
  useEffect(() => {
    setThemeState(currentTheme());
    return subscribeTheme(setThemeState);
  }, []);
  return theme;
}
