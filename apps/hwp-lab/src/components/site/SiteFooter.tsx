import { REPO } from "@/app/docs/docsRegistry";
import { docHref, siteHref } from "./paths";
import styles from "./site.module.css";

// 공통 푸터 — 서버 컴포넌트. 링크만 있고 상태가 없다.
// 카피 규율: 여기 적는 사실(라이선스·패키지명)은 레포에서 검증 가능한 것만 쓴다.
//   Apache-2.0 = LICENSE 파일, @auto-hwp/engine·react = packages/*/package.json.

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <b>오토한글 (auto-hwp)</b>
          <p>
            한글(HWP) 문서를 여는 것부터 내보내는 것까지 하나의 문서 모델로 처리하는 오픈소스 엔진과 편집기
            SDK입니다.
          </p>
        </div>
        <div className={styles.col}>
          <b>제품</b>
          <a href={siteHref("/")}>웹 데모</a>
          <a href={siteHref("/bulk")}>양식 일괄 작성</a>
          <a href={siteHref("/bench")}>충실도 벤치마크</a>
        </div>
        <div className={styles.col}>
          <b>문서</b>
          <a href={siteHref("/docs")}>전체 문서</a>
          <a href={docHref("embed")}>임베드 가이드</a>
          <a href={docHref("cli")}>CLI</a>
          <a href={docHref("mcp")}>MCP</a>
        </div>
        <div className={styles.col}>
          <b>소스</b>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="https://www.npmjs.com/package/@auto-hwp/engine" target="_blank" rel="noreferrer">
            npm · engine
          </a>
          <a href="https://www.npmjs.com/package/@auto-hwp/react" target="_blank" rel="noreferrer">
            npm · react
          </a>
          <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
            Apache-2.0
          </a>
        </div>
      </div>
      <div className={styles.legal}>
        Apache-2.0 라이선스 · 「한글」과 HWP는 (주)한글과컴퓨터의 상표이며, 이 프로젝트는 한글과컴퓨터와
        무관한 독립 구현입니다.
      </div>
    </footer>
  );
}
