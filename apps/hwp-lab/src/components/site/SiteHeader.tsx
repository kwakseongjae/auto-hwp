import { ExternalLink } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { REPO } from "@/app/docs/docsRegistry";
import { siteHref } from "./paths";
import styles from "./site.module.css";

// 공통 사이트 헤더 — **서버 컴포넌트**다("use client" 금지). 유일한 클라이언트 조각은 ThemeToggle.
// 편집기 화면(문서를 연 뒤)에는 붙지 않는다 — 거기는 기존 앱 헤더(.lab-header)가 담당한다.

export type SiteNavKey = "home" | "bulk" | "bench" | "docs";

// ⚠️ 홈("데모") 항목은 두지 않는다 — 왼쪽 로고가 이미 홈 앵커이고, 랜딩 헤더에 붙은 "데모" 태그는
// 제품을 스스로 견본 취급하게 만든다(사용자 피드백: 에디터의 "정적 데모·AI" 라벨을 걷어낸 것과 같은
// 이유). `SiteNavKey` 의 "home" 은 남겨 둔다 — 현재 페이지 표시(current)로 계속 쓰인다.
const NAV: { key: SiteNavKey; href: string; label: string; title: string }[] = [
  { key: "bulk", href: siteHref("/bulk"), label: "양식 일괄 작성", title: "양식 1개 + 명단 N행 → 완성본 N부" },
  { key: "bench", href: siteHref("/bench"), label: "벤치마크", title: "한컴 저장값 대비 충실도 수치와 재현 커맨드" },
  { key: "docs", href: siteHref("/docs"), label: "Docs", title: "임베드·CLI·MCP·Intent 스키마 문서" },
];

export function SiteHeader({ current }: { current?: SiteNavKey }) {
  return (
    <header className={styles.header}>
      <a className={styles.brand} href={siteHref("/")}>
        오토한글
        <small>auto-hwp</small>
      </a>
      <nav className={styles.nav} aria-label="사이트">
        {NAV.map((n) => (
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
