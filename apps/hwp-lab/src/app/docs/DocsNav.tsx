import { docHref } from "@/components/site/paths";
import styles from "./docs.module.css";
import { DOC_GROUPS, docsInGroup } from "./docsRegistry";

// 좌측 문서 네비 — 서버 컴포넌트. 현재 문서는 `current` slug 로 표시한다(클라 상태 없음).


export function DocsNav({ current }: { current?: string }) {
  return (
    <nav aria-label="문서" data-testid="docs-nav">
      {DOC_GROUPS.map((g) => (
        <div key={g.id} className={styles.sideGroup}>
          <b>{g.label}</b>
          <ul>
            {docsInGroup(g.id).map((d) => (
              <li key={d.slug}>
                <a href={docHref(d.slug)} aria-current={current === d.slug ? "page" : undefined}>
                  {d.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
