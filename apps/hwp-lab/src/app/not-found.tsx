"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { parseDocUrl } from "@/lib/docUrl";

// 404 화면 — 그리고 **정적 배포(GitHub Pages)에서 문서 세션 URL(/d/<키>)이 도착하는 문**이다.
//
// 왜 여기인가: `/d/<키>` 는 서버가 아무 것도 모르는 클라이언트 전용 주소다(키는 이 브라우저 안에서만
// 스냅샷으로 환원된다). full Next 배포(Vercel)에서는 next.config 의 rewrite 가 그 주소를 루트 앱으로
// 넘기지만, `output:"export"` 정적 사이트에는 rewrite 자체가 없다 — 호스팅이 미지의 경로에 404.html
// 을 돌려줄 뿐이다. 그 404.html 이 바로 이 파일이므로, 주소가 문서 세션 URL 이면 여기서 같은 앱을
// 태운다(앱이 주소를 읽어 재개하거나, 되살릴 게 없으면 정직하게 안내하고 홈으로 보낸다).
//
// 그 밖의 주소에서는 평범한 404 다 — 앱을 태우지 않고 홈 링크만 준다.
const LabWorkspace = dynamic(() => import("../components/LabWorkspace"), {
  ssr: false,
  loading: () => <div className="lab-empty">앱을 불러오는 중…</div>,
});

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function NotFound() {
  // 프리렌더(빌드 시점)에는 주소를 알 수 없으므로 **마운트 후에** 판정한다. 판정 전에는 아무 것도
  // 단정하지 않는다(문서 주소인데 "없는 페이지"를 깜빡이면 그게 거짓말이다).
  const [isDocUrl, setIsDocUrl] = useState<boolean | null>(null);
  useEffect(() => {
    setIsDocUrl(parseDocUrl(window.location.pathname, BASE) !== null);
  }, []);

  if (isDocUrl === null) return <div className="lab-empty">불러오는 중…</div>;
  if (isDocUrl) return <LabWorkspace />;

  return (
    <div className="lab-empty" data-testid="not-found">
      <h1 style={{ fontSize: 20, margin: 0, color: "var(--ah-fg-strong)" }}>페이지를 찾을 수 없습니다</h1>
      <p style={{ margin: 0 }}>주소가 바뀌었거나 없는 페이지입니다.</p>
      <a className="lab-btn lab-btn-accent" href={`${BASE}/`}>
        첫 화면으로
      </a>
    </div>
  );
}
