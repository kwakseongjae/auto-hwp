"use client";

import Script from "next/script";
import { useEffect, useState } from "react";
import {
  ANALYTICS_CONSENT_EVENT,
  readAnalyticsConsent,
  writeAnalyticsConsent,
  type AnalyticsConsent as Consent,
} from "@/lib/analyticsConsent";
import styles from "./AnalyticsConsent.module.css";

const RAW_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || "";
const MEASUREMENT_ID = /^G-[A-Z0-9]+$/.test(RAW_MEASUREMENT_ID) ? RAW_MEASUREMENT_ID : "";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function AnalyticsConsent() {
  const [consent, setConsent] = useState<Consent>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setConsent(readAnalyticsConsent());
    sync();
    setReady(true);
    window.addEventListener(ANALYTICS_CONSENT_EVENT, sync);
    return () => window.removeEventListener(ANALYTICS_CONSENT_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!MEASUREMENT_ID) return;
    (window as unknown as Record<string, unknown>)[`ga-disable-${MEASUREMENT_ID}`] = consent !== "granted";
  }, [consent]);

  if (!MEASUREMENT_ID || !ready) return null;

  return (
    <>
      {consent === "granted" && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`} strategy="afterInteractive" />
          <Script id="auto-hwp-ga4" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','${MEASUREMENT_ID}',{anonymize_ip:true});`}
          </Script>
        </>
      )}
      {consent === null && (
        <aside className={styles.banner} role="dialog" aria-label="방문 분석 선택" data-testid="analytics-consent">
          <div>
            <b>오토한글을 더 잘 만들기 위한 익명 사용 흐름</b>
            <p>
              동의하면 Google Analytics로 페이지 방문과 문서 열기·AI 요청·내보내기 같은 성공 여부만 봅니다.
              파일명·문서 내용·AI 지시문과 응답은 보내지 않습니다. 거부해도 모든 기능을 그대로 쓸 수 있습니다.
              {" "}<a href={`${BASE}/privacy`}>자세히 보기</a>
            </p>
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={() => writeAnalyticsConsent("denied")}>
              거부
            </button>
            <button type="button" className={styles.accept} onClick={() => writeAnalyticsConsent("granted")}>
              익명 분석 허용
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
