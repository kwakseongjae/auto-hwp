import { BASE, docHref, siteHref } from "./paths";
import styles from "./landing.module.css";

// 랜딩 기능 쇼케이스 — 레포 README 의 GIF 3종을 그대로 쓴다(copy-docs-assets.mjs 가 public/docs-assets 로 복사).
// 카피 규율: 문구는 README 표의 설명을 그대로 옮긴 것이다(과장 금지 — "AI가 개입하지 않는 기본 경로",
// "규칙 기반이라 AI 없이 돕니다" 같은 한계 고지를 지우지 않는다).
//
// LabWorkspace(클라이언트 컴포넌트)에서 부르므로 이 파일도 클라이언트 트리에 들어간다 —
// 상태·이펙트 없이 마크업만 두고, GIF 는 전부 lazy(총 2.5MB, 첫 화면 아래에 있다).

const CARDS = [
  {
    gif: "guide-engine.gif",
    alt: "한글 파일을 열어 화면에 그리고 PDF로 내보내는 장면",
    title: "엔진",
    body: "한글 파일을 열고, 원본 그대로 화면에 그리고, PDF·HTML·HWPX로 내보냅니다. AI가 전혀 개입하지 않는 기본 경로입니다.",
    href: siteHref("/bench"),
    cta: "충실도 수치 보기 →",
  },
  {
    gif: "guide-vibe.gif",
    alt: "표를 지정하고 말로 편집을 지시해 카드로 확인한 뒤 적용하는 장면",
    title: "바이브 편집",
    body: "고칠 자리를 지정하고 말로 지시하면 제안이 카드로 먼저 뜹니다. 승인한 카드만 문서에 닿고, 카드 단위로 되돌립니다.",
    href: docHref("intent-schema"),
    cta: "Intent 스키마 →",
  },
  {
    gif: "guide-bulk.gif",
    alt: "양식과 명단을 넣어 완성본 여러 부를 한 번에 만드는 장면",
    title: "양식 일괄 작성",
    body: "양식 1개와 명단 N행을 넣으면 완성본 N부가 zip으로 나옵니다. 규칙 기반이라 AI 없이 돕니다.",
    href: siteHref("/bulk"),
    cta: "일괄 작성 열기 →",
  },
];

export function LandingShowcase() {
  return (
    <section className={styles.showcase} data-testid="landing-showcase">
      <div className={styles.head}>
        <p className={styles.kicker}>세 가지 쓰임</p>
        <h2 className={styles.title}>열고 그리는 엔진, 말로 고치는 편집, 명단만큼 찍어내는 일괄 작성</h2>
        <p className={styles.sub}>
          아래 장면은 모두 실제 화면 녹화입니다. 엔진 경로(열기·렌더·내보내기)와 일괄 작성은 AI 없이
          돌고, 바이브 편집만 승인 후에 문서에 닿습니다.
        </p>
      </div>

      <div className={styles.grid}>
        {CARDS.map((c) => (
          <div key={c.gif} className={styles.card}>
            {/* eslint-disable-next-line @next/next/no-img-element -- GIF 애니메이션은 next/image 최적화 대상이 아니다 */}
            <img className={styles.shot} src={`${BASE}/docs-assets/${c.gif}`} alt={c.alt} loading="lazy" decoding="async" />
            <div className={styles.cardBody}>
              <b>{c.title}</b>
              <p>{c.body}</p>
              <a href={c.href}>{c.cta}</a>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.community} data-testid="community-contribution">
        <div className={styles.communityCopy}>
          <p className={styles.kicker}>베타를 함께 완성하는 가장 가벼운 방법</p>
          <h2 className={styles.title}>문서 하나를 열어 보는 것부터 컨트리뷰션입니다</h2>
          <p className={styles.sub}>
            오토한글(auto-hwp)은 AI가 한글을 이해하고, 수정하고, 마침내 정복할 수 있는 미래를 만듭니다.
            지금은 서로 다른 문서의 긴 꼬리를 집단지성으로 찾아야 하는 베타 단계입니다.
          </p>
          <ol className={styles.steps}>
            <li><b>브라우저에서 문서를 엽니다.</b> 파일은 문서 처리 서버로 업로드되지 않습니다.</li>
            <li><b>한/글·한컴독스와 화면을 비교합니다.</b> 쪽수·줄바꿈·표·글꼴 차이를 찾습니다.</li>
            <li><b>레이아웃 문제 제보를 누릅니다.</b> 파일명·본문·해시 없이 GitHub 초안이 열립니다.</li>
          </ol>
          <div className={styles.communityActions}>
            <a className={styles.primaryAction} href="#try-document">내 문서로 확인하기</a>
            <a href="https://github.com/kwakseongjae/auto-hwp/issues/new?template=layout-gap.md" target="_blank" rel="noreferrer">
              제보 양식 미리 보기 →
            </a>
          </div>
          <p className={styles.privacyNote}>
            공개 이슈에 직접 적은 내용은 GitHub에 남습니다. 비공개 문서·파일명·본문·개인정보는 올리지 마세요.
          </p>
        </div>
        {/* 실제 브라우저 화면 — 릴리스 촬영 스크립트가 같은 경로에 결정적으로 갱신한다. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- 정적 제품 스크린샷, 원본 비율 유지 */}
        <img
          className={styles.communityShot}
          src={`${BASE}/docs-assets/launch-layout-report.png`}
          alt="오토한글 편집 화면 상단의 레이아웃 문제 제보 버튼과 8쪽 한글 문서"
          loading="lazy"
          decoding="async"
        />
      </div>

      <div className={styles.paths}>
        <a className={styles.path} href={siteHref("/docs")} data-testid="docs-link">
          <b>문서</b>
          <p>
            내 앱에 편집기를 얹는 법(React SDK), 터미널에서 쓰는 CLI, AI 도구에 붙이는 MCP 서버,
            그리고 AI가 낼 수 있는 편집 명령의 전체 계약까지 — 레포 마크다운 원문 그대로 읽습니다.
          </p>
          <span>문서 허브 열기 →</span>
        </a>
        <a className={styles.path} href={siteHref("/bench")}>
          <b>충실도 벤치마크</b>
          <p>
            한글이 문서에 저장해 둔 줄바꿈(lineseg)을 정답지로 놓고 우리 조판을 자동 대조한 수치입니다.
            모든 숫자에 재현 커맨드와 한계 고지가 붙어 있습니다.
          </p>
          <span>수치와 재현 커맨드 →</span>
        </a>
      </div>
    </section>
  );
}
