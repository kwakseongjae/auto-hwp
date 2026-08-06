import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { docHref, siteHref } from "@/components/site/paths";
import styles from "../docs.module.css";
import { DOCS, REPO, docBySlug } from "../docsRegistry";
import { readDoc } from "../docsSource";
import { DocsNav } from "../DocsNav";

// /docs/[slug] — **정적 생성**. generateStaticParams 가 있으므로 `next build`(Vercel)에서도,
// `output:"export"`(build:demo/Pages)에서도 빌드 타임에 전부 HTML 로 떨어진다. 즉 런타임에
// 파일시스템을 읽지 않는다(레포 마크다운은 빌드 머신에만 있으면 된다).
export const dynamic = "force-static";
export const dynamicParams = false;

// canonical/og 의 URL 은 metadataBase 기준 **상대 경로**로 준다 — siteHref 와 같은 슬래시 규칙.
const SLASH = process.env.NEXT_PUBLIC_DEMO === "1" ? "/" : "";

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const entry = docBySlug(slug);
  if (!entry) return {};
  const ogTitle = `${entry.title} · 오토한글 (auto-hwp)`;
  return {
    title: entry.title,
    description: entry.summary,
    alternates: { canonical: `/docs/${entry.slug}${SLASH}` },
    openGraph: {
      type: "article",
      locale: entry.lang === "en" ? "en_US" : "ko_KR",
      siteName: "오토한글 (auto-hwp)",
      url: `/docs/${entry.slug}${SLASH}`,
      title: ogTitle,
      description: entry.summary,
      images: [{ url: "/og.png", width: 1200, height: 630, type: "image/png", alt: ogTitle }],
    },
    twitter: { card: "summary_large_image", title: ogTitle, description: entry.summary, images: ["/og.png"] },
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = docBySlug(slug);
  if (!entry) notFound();

  const { html, toc } = readDoc(entry);
  const idx = DOCS.findIndex((d) => d.slug === entry.slug);
  const prev = idx > 0 ? DOCS[idx - 1] : null;
  const next = idx >= 0 && idx < DOCS.length - 1 ? DOCS[idx + 1] : null;

  return (
    <div className={styles.page}>
      <SiteHeader current="docs" />
      <div className={toc.length ? styles.shell : `${styles.shell} ${styles.shellNoToc}`}>
        <aside className={styles.side}>
          <DocsNav current={entry.slug} />
        </aside>

        <main className={styles.main}>
          <nav className={styles.crumb}>
            <a href={siteHref("/")}>오토한글</a>
            <span aria-hidden>›</span>
            <a href={siteHref("/docs")}>문서</a>
            <span aria-hidden>›</span>
            <span>{entry.title}</span>
          </nav>

          <h1 className={styles.docTitle} data-testid="doc-title">
            {entry.title}
          </h1>
          {/* lede 는 문서 본문의 첫 문단이 아니라 **레지스트리의 큐레이션 요약**이다 — 본문 첫
              문단을 뽑아 쓰면 바로 아래 본문과 같은 문장이 두 번 보인다(EMBED-GUIDE 실측). */}
          <p className={styles.lede}>{entry.summary}</p>
          <p className={styles.sourceLine}>
            원문:{" "}
            <a href={`${REPO}/blob/main/${entry.file}`} target="_blank" rel="noreferrer">
              {entry.file}
            </a>{" "}
            · 이 페이지는 빌드할 때 그 파일에서 생성됩니다.
          </p>

          {/* 신뢰 경계: 입력은 레포에 커밋된 우리 마크다운뿐이고, 렌더는 빌드 타임에 한 번 끝난다
              (docsSource.ts 주석 참고). 사용자 입력이 이 경로에 들어오면 반드시 sanitize 를 끼워라. */}
          <div className={styles.body} data-testid="doc-body" dangerouslySetInnerHTML={{ __html: html }} />

          {(prev || next) && (
            <div className={styles.pager}>
              {prev && (
                <a href={docHref(prev.slug)}>
                  <small>이전</small>
                  {prev.title}
                </a>
              )}
              {next && (
                <a className={styles.pagerNext} href={docHref(next.slug)}>
                  <small>다음</small>
                  {next.title}
                </a>
              )}
            </div>
          )}
        </main>

        {toc.length > 0 && (
          <aside className={styles.toc} data-testid="doc-toc">
            <b>이 문서에서</b>
            <ul>
              {toc.map((t) => (
                <li key={t.id} className={t.depth === 3 ? styles.tocD3 : undefined}>
                  <a href={`#${t.id}`}>{t.text}</a>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
      <SiteFooter />
    </div>
  );
}
