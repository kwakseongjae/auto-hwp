import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { hostnameOf, isDemoStaticBuild, isLocalModelsFlagOn, isLoopbackHostname } from "@/lib/openrouter/gating";
import { ModelsPanel } from "./ModelsPanel";
import styles from "./models.module.css";

const STATIC_DEMO = process.env.DEMO_STATIC === "1";

export const dynamic = STATIC_DEMO ? "force-static" : "force-dynamic";

export const metadata: Metadata = {
  title: "Models",
  description: "로컬 전용 OpenRouter 연결과 모델 선택.",
  robots: { index: false, follow: false },
};

export default async function ModelsPage() {
  if (STATIC_DEMO || !isLocalModelsFlagOn() || isDemoStaticBuild()) notFound();
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  if (!isLoopbackHostname(hostnameOf(host))) notFound();

  return (
    <div className={styles.page}>
      <SiteHeader current="models" />
      <main className={styles.main}>
        <p className={styles.kicker}>LOCAL ONLY</p>
        <h1>Models</h1>
        <p className={styles.lede}>
          이 화면은 로컬 개발 서버에서만 열립니다. OpenRouter 키는 브라우저에 내려가지 않고 이
          서버 프로세스 메모리에만 있습니다.
        </p>
        <ModelsPanel />
      </main>
      <SiteFooter />
    </div>
  );
}
