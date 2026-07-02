"use client";

import dynamic from "next/dynamic";

// 워크스페이스는 @tf-hwp/react + wasm(브라우저 전용)에 의존하므로 SSR을 끈다(이슈 §페이지:
// next/dynamic ssr:false). Server Component에서는 ssr:false 가 금지되므로 이 페이지를 "use client"
// 로 두고 dynamic import 한다.
const LabWorkspace = dynamic(() => import("../components/LabWorkspace"), {
  ssr: false,
  loading: () => <div className="lab-empty">앱을 불러오는 중…</div>,
});

export default function Page() {
  return <LabWorkspace />;
}
