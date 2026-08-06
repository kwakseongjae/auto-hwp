import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { docHref } from "@/components/site/paths";
import styles from "./docs.module.css";
import { DOCS, DOC_GROUPS, REPO, docsInGroup } from "./docsRegistry";
import { DocsNav } from "./DocsNav";

// /docs 허브 — **서버 컴포넌트 · 정적**. "use client" 금지(크롤러가 JS 없이 읽어야 한다).
export const dynamic = "force-static";

export default function DocsHubPage() {
  return (
    <div className={styles.page}>
      <SiteHeader current="docs" />
      <div className={`${styles.shell} ${styles.shellNoToc}`}>
        <aside className={styles.side}>
          <DocsNav />
        </aside>
        <main className={styles.main}>
          <div className={styles.hubHead}>
            <p className={styles.hubKicker}>문서</p>
            <h1 className={styles.hubTitle}>오토한글 문서</h1>
            <p className={styles.hubLede}>
              레포에 있는 사용자용 문서를 그대로 싣습니다 — 이 페이지의 본문은 GitHub의 마크다운
              원문에서 빌드할 때 생성되므로, 레포와 사이트가 어긋날 수 없습니다.
            </p>
          </div>

          {DOC_GROUPS.map((g) => (
            <section key={g.id}>
              <h2 className={styles.groupHead}>{g.label}</h2>
              <p className={styles.groupBlurb}>{g.blurb}</p>
              <div className={styles.cards}>
                {docsInGroup(g.id).map((d) => (
                  <a key={d.slug} className={styles.card} href={docHref(d.slug)} data-testid={`doc-card-${d.slug}`}>
                    <span className={styles.cardTitle}>
                      {d.title}
                      {d.lang === "en" && <em>EN</em>}
                    </span>
                    <p className={styles.cardSummary}>{d.summary}</p>
                  </a>
                ))}
              </div>
            </section>
          ))}

          <p className={styles.hubNote}>
            여기 없는 문서(설계 노트·이슈·세션 로그)는 레포에 그대로 있습니다 —{" "}
            <a href={`${REPO}/tree/main/docs`} target="_blank" rel="noreferrer">
              GitHub의 docs/
            </a>
            를 보세요. 현재 사이트에 실린 문서는 {DOCS.length}건입니다.
          </p>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
