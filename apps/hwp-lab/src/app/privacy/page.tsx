import type { Metadata } from "next";
import { REPO } from "@/app/docs/docsRegistry";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { PrivacyControls } from "./PrivacyControls";
import styles from "./privacy.module.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "개인정보 및 로컬 데이터",
  description: "오토한글 데모의 로컬 문서 처리, 자동저장, 선택적 AI 전송과 보유 범위.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className={styles.page}>
      <SiteHeader />
      <main className={styles.main}>
        <p className={styles.kicker}>LOCAL FIRST, DISCLOSED WHEN OPTIONAL</p>
        <h1>개인정보 및 로컬 데이터 안내</h1>
        <p className={styles.lede}>
          오토한글(auto-hwp)의 기본 문서 경로는 브라우저 안에서 동작합니다. AI 편집은 별도 선택 사항이며,
          그때만 아래에 적은 문맥이 명시적 동의 뒤 외부 처리자에게 전달됩니다.
        </p>
        <p className={styles.updated}>최종 갱신: 2026-08-12 · 적용 대상: autohwp.com 라이브 데모</p>

        <section>
          <h2>한눈에 보는 데이터 경계</h2>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>경로</th>
                  <th>처리하는 데이터</th>
                  <th>위치·보유</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>열기·렌더·수동 편집·내보내기</th>
                  <td>선택한 HWP/HWPX 바이트와 편집 상태</td>
                  <td>브라우저의 Rust/wasm 엔진. 문서 처리 서버로 업로드하지 않음</td>
                </tr>
                <tr>
                  <th>자동저장·새로고침 복구</th>
                  <td>원본 시드 또는 편집된 HWPX 스냅샷, 파일명, 저장 시각</td>
                  <td>이 브라우저의 IndexedDB. 최대 5개, 7일 TTL</td>
                </tr>
                <tr>
                  <th>선택적 데모 AI 편집</th>
                  <td>지시문, 문서 프로필, 본문 발췌, 표 내용, 선택 위치</td>
                  <td>오토한글 Vercel 프록시를 거쳐 OpenRouter의 ZDR 가능 경로로 요청 시점에 전송</td>
                </tr>
                <tr>
                  <th>남용 방지</th>
                  <td>요청 IP와 날짜별 사용 횟수</td>
                  <td>
                    서버 메모리 또는 Upstash 카운터 키. 약 25시간 뒤 만료. 기본 한도는 IP당 20회·전체
                    400회이며, Upstash가 없으면 서버 인스턴스별 best-effort입니다.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>브라우저에 남는 것</h2>
          <p>
            자동저장 스냅샷은 IndexedDB에만 남고 서버와 동기화되지 않습니다. 같은 문서를 다시 열기 위한
            불투명 주소 매핑(최근 24개), 테마, AI 동의 여부는 localStorage에, 현재 탭의 재개 마커는
            sessionStorage에 저장됩니다. 문서 URL만 다른 기기로 보내도 문서가 공유되지는 않습니다.
          </p>
          <p>
            브라우저의 사이트 데이터 삭제 기능으로 이 로컬 데이터를 지울 수 있습니다. 자동저장에는 아직
            내보내지 않은 편집이 있을 수 있으므로, 삭제 전에 필요한 결과를 PDF·HTML·HWPX로 내려받으세요.
          </p>
        </section>

        <section>
          <h2>AI 편집을 선택할 때</h2>
          <p>
            AI 버튼을 누르면 먼저 전송 범위를 보여 주고 동의를 받습니다. 거부하면 AI 요청과 문서 문맥
            전송은 일어나지 않으며 열기·수동 편집·내보내기는 계속 사용할 수 있습니다. 원본 파일 전체를
            AI 요청에 첨부하지 않지만, 발췌와 표 내용에는 개인정보가 포함될 수 있으므로 확인 후 사용하세요.
          </p>
          <p>
            <strong>
              AI 문맥은 전송되지만, 오토한글(auto-hwp)은 원본 문서·전송된 문맥·AI 응답을 자체
              데이터베이스나 스토리지에 저장·보유하지 않습니다.
            </strong>{" "}
            OpenRouter 요청은 zero-data-retention 제공자를 요구하며 해당 경로가 없으면 실패하도록 구성돼
            있습니다. 다만 Vercel·OpenRouter·Upstash 같은 인프라 처리자는 보안 및 운영을 위해 HTTP 메타데이터를
            각자 정책에 따라 처리할 수 있습니다.
          </p>
          <p>
            문서 내용과 별개로, 남용 방지를 위한 IP·날짜별 사용 횟수 키만 서버 메모리 또는 Upstash에 약
            25시간 유지됩니다. 이 키에는 문서 파일·본문·AI 응답이 들어가지 않습니다.
          </p>
          <p>
            공개 데모 AI는 이미지·참조 문서 첨부를 전송하지 않습니다. 첨부가 있는 요청은 네트워크 전송
            전에 거부하며, 첨부 기반 작업이 필요하면 자신의 BYOK 프록시에서 별도 정책을 정해야 합니다.
          </p>
          <PrivacyControls />
        </section>

        <section>
          <h2>분석·쿠키·외부 제품에 임베드할 때</h2>
          <p>
            현재 데모에는 광고, 행동 분석 SDK, 제3자 추적 쿠키가 없습니다. CDN에서 엔진 바이트를 받는 기본
            설정은 네트워크 요청이며, 폐쇄망에서는 임베드 가이드의 자기호스팅 경로로 바꿀 수 있습니다.
          </p>
          <p>
            npm 패키지·CLI·MCP를 자신의 제품이나 인프라에 붙인 운영자는 별도의 데이터 처리자입니다. 어떤
            LLM, 로그, 보유 기간을 선택하는지는 그 운영자의 정책에 따르며 이 데모 안내가 대신하지 않습니다.
          </p>
        </section>

        <section>
          <h2>레이아웃·보안 제보</h2>
          <p>
            편집 화면의 <strong>레이아웃 문제 제보</strong> 버튼은 파일명·본문·해시를 제외한 GitHub 이슈
            초안을 엽니다. 공개 이슈에 작성한 내용은 GitHub에 저장되므로 비공개 문서나 개인정보를
            붙이지 마세요. 일반적인 개인정보 질문도 개인 내용을 싣지 않은 상태로{" "}
            <a href={REPO + "/issues/new"} target="_blank" rel="noreferrer">
              GitHub 이슈
            </a>
            를 이용하세요. 취약점·노출 가능성·실제 개인 데이터가 관련되면 공개 이슈 대신{" "}
            <a href={REPO + "/security/advisories/new"} target="_blank" rel="noreferrer">
              비공개 보안 제보
            </a>
            를 이용하세요.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
