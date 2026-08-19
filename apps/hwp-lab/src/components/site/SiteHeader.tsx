import { ExternalLink } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { REPO } from "@/app/docs/docsRegistry";
import { BASE, siteHref } from "./paths";
import styles from "./site.module.css";

// 공통 사이트 헤더 — **서버 컴포넌트**다("use client" 금지). 유일한 클라이언트 조각은 ThemeToggle.
// 편집기 화면(문서를 연 뒤)에는 붙지 않는다 — 거기는 기존 앱 헤더(.lab-header)가 담당한다.

export type SiteNavKey = "home" | "bulk" | "bench" | "docs" | "models";

// ⚠️ 홈("데모") 항목은 두지 않는다 — 왼쪽 로고가 이미 홈 앵커이고, 랜딩 헤더에 붙은 "데모" 태그는
// 제품을 스스로 견본 취급하게 만든다(사용자 피드백: 에디터의 "정적 데모·AI" 라벨을 걷어낸 것과 같은
// 이유). `SiteNavKey` 의 "home" 은 남겨 둔다 — 현재 페이지 표시(current)로 계속 쓰인다.
const NAV: { key: SiteNavKey; href: string; label: string; title: string }[] = [
  { key: "bulk", href: siteHref("/bulk"), label: "양식 일괄 작성", title: "양식 1개 + 명단 N행 → 완성본 N부" },
  { key: "bench", href: siteHref("/bench"), label: "벤치마크", title: "한컴 저장값 대비 충실도 수치와 재현 커맨드" },
  { key: "docs", href: siteHref("/docs"), label: "Docs", title: "임베드·CLI·MCP·Intent 스키마 문서" },
];

const MODELS_NAV: { key: SiteNavKey; href: string; label: string; title: string } = {
  key: "models",
  href: siteHref("/models"),
  label: "Models",
  title: "로컬 OpenRouter 연결 · 모델 선택",
};

export function SiteHeader({ current }: { current?: SiteNavKey }) {
  const items =
    process.env.NEXT_PUBLIC_AUTO_HWP_LOCAL_MODELS === "1"
      ? [...NAV, MODELS_NAV]
      : NAV;
  return (
    <header className={styles.header}>
      {/* 로고 = 낙관(도장) + 워드텍스트. 도장은 장식이라 alt 를 비운다 — 바로 옆에 같은 뜻의
          글자가 있고, 스크린리더가 "오토한글 오토한글"로 두 번 읽으면 안 된다.
          next/image 가 아니라 <img> 인 이유: 이 앱은 정적 export(Pages)도 나가고, 20px 짜리
          한 장에 최적화 파이프라인을 태울 이유가 없다. */}
      <a className={styles.brand} href={siteHref("/")}>
        <img className={styles.seal} src={`${BASE}/brand/seal.png`} alt="" width={20} height={20} />
        <span className={styles.brandName}>오토한글</span>
        <small>auto-hwp</small>
      </a>
      <nav className={styles.nav} aria-label="사이트">
        {items.map((n) => (
          <a key={n.key} href={n.href} title={n.title} aria-current={current === n.key ? "page" : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <span className={styles.spacer} />
      <a className={styles.ghost} href={REPO} target="_blank" rel="noreferrer">
        GitHub <ExternalLink size={12} />
      </a>
      <ThemeToggle />
    </header>
  );
}
