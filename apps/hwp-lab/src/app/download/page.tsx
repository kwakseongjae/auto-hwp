import { ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import styles from "./download.module.css";
import { ThemeToggle } from "@/components/ThemeToggle";
import { siteHref } from "@/components/site/paths";

// ⚠️ 서버 컴포넌트 · 정적 콘텐츠. "use client" 를 붙이지 마라 — 다운로드 페이지는 JS 없이도 읽혀야
// 하고, 크롤러·공유 스크래퍼가 무엇을 받는 페이지인지 알 수 있어야 한다.
//
// ## 이 페이지의 규율
//
// **지원하지 않는 것을 지원하는 척하지 않는다**(#144 수락 기준: "Release page states unsupported
// packages/architectures honestly"). 지금 있는 것은 macOS Apple Silicon 하나뿐이고 그렇게 쓴다.
// 다른 플랫폼 자리에 "곧" 이라 적고 회색 버튼을 두는 것은 눌러 본 사람에게 하는 거짓말이다.
//
// **체크섬을 함께 싣는다.** 서명·공증이 애플 쪽 신뢰라면 SHA-256 은 우리가 올린 바이트가 그대로인지
// 사용자가 **직접** 확인하는 수단이다. 둘은 서로를 대체하지 않는다.
//
// 릴리스를 새로 올릴 때 `TAG`·`DMG`·`SHA256`·`SIZE` 를 함께 갱신한다. 틀린 체크섬은 없는 것보다 나쁘다.
// ⚠️ 해시는 **staple 이 끝난 뒤** 잰다. 공증 티켓을 붙이면 파일 바이트가 바뀌어 해시도 달라진다 —
// 공증 전 값을 실으면 사용자가 검증에 실패하고 우리를 의심하게 된다.

const REPO = "https://github.com/kwakseongjae/auto-hwp";
const TAG = "desktop-v0.0.1";
const DMG = "auto-hwp_0.0.1_aarch64.dmg";
const DOWNLOAD = `${REPO}/releases/download/${TAG}/${DMG}`;
const SHA256 = "12d1b099a2e838972b35666dfde634c267591bbd4d7e9349eeaad6465f80f84b";
const SIZE = "11 MB";

export const metadata = {
  title: "데스크톱 앱 내려받기 — auto-hwp",
  description:
    "한글 문서를 열고 고치고 되돌리는 macOS 앱. Apple 공증됨. 문서는 이 기기를 떠나지 않습니다.",
};

export default function Page() {
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <a className={styles.back} href={siteHref("/")}>
          <ArrowLeft size={16} aria-hidden /> auto-hwp
        </a>
        <ThemeToggle />
      </header>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>데스크톱 · {TAG.replace("desktop-v", "")}</p>
        <h1 className={styles.title}>한글 문서를, 한컴 없이.</h1>
        <p className={styles.lede}>
          열고 · 고치고 · 되돌리고 · PDF 로 내보냅니다.{" "}
          <strong>문서는 이 기기를 떠나지 않습니다</strong> — 계정도 업로드도 없습니다.
        </p>

        <a className={styles.cta} href={DOWNLOAD}>
          macOS 용 내려받기
          <span className={styles.ctaSub}>
            Apple Silicon · .dmg · {SIZE}
          </span>
        </a>

        <p className={styles.signed}>
          <ShieldCheck size={14} aria-hidden /> Apple 공증됨 — 경고 없이 열립니다
        </p>
      </section>

      <section className={styles.section}>
        <h2>무엇을 받는가</h2>
        <dl className={styles.facts}>
          <div>
            <dt>버전</dt>
            <dd>{TAG.replace("desktop-v", "")}</dd>
          </div>
          <div>
            <dt>지원</dt>
            <dd>macOS · Apple Silicon (arm64)</dd>
          </div>
          <div>
            <dt>서명</dt>
            <dd>Developer ID · 공증 · staple</dd>
          </div>
          <div className={styles.wide}>
            <dt>SHA-256</dt>
            <dd>
              <code className={styles.hash}>{SHA256}</code>
            </dd>
          </div>
        </dl>
        <p className={styles.note}>
          받은 파일을 직접 확인하려면 <code>shasum -a 256 {DMG}</code> 를 돌려 위 값과 비교하세요.
        </p>
      </section>

      <section className={styles.section}>
        <h2>0.0.1 에 있는 것</h2>
        <ul className={styles.features}>
          <li>
            <b>대시보드</b> — 최근 문서에서 이어서 시작합니다.
          </li>
          <li>
            <b>버전 기록</b> — 지점을 저장하고 되돌립니다. 되돌리기 직전 상태도 자동으로 남아, 되돌린
            뒤에도 돌아올 수 있습니다.
          </li>
          <li>
            <b>검수</b> — 우리 조판이 한/글이 파일에 남긴 레이아웃과 몇 쪽·몇 줄 맞는지 보여 줍니다.
          </li>
          <li>
            <b>복제</b> — 사본으로 실험하고 원본은 그대로 둡니다.
          </li>
          <li>PDF · HTML · HWPX 내보내기, 시스템 인쇄, 파일 연결, 크래시 복구.</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>아직 없는 것</h2>
        <ul className={styles.missing}>
          <li>
            <b>Intel Mac</b> — 아직 빌드하지 않습니다.
          </li>
          <li>
            <b>Windows · Linux</b> — 코드서명이 준비되기 전까지 배포하지 않습니다. 없는 것을 있는 것처럼
            두지 않으려는 것입니다.
          </li>
          <li>
            <b>자동 업데이트</b> — 0.0.1 에는 없습니다. 새 버전은 이 페이지에서 받습니다.
          </li>
        </ul>
        <p className={styles.note}>
          설치 없이 써 보시려면 <a href={siteHref("/")}>브라우저 버전</a>이 있습니다.
        </p>
      </section>

      <footer className={styles.foot}>
        <a href={`${REPO}/releases/tag/${TAG}`} target="_blank" rel="noreferrer">
          릴리스 노트 <ExternalLink size={13} aria-hidden />
        </a>
        <a href={REPO} target="_blank" rel="noreferrer">
          소스 <ExternalLink size={13} aria-hidden />
        </a>
      </footer>
    </main>
  );
}
