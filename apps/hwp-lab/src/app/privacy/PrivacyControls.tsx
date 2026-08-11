"use client";

import { useState } from "react";
import { revokeDemoAiConsent } from "@/lib/demoAiConsent";
import styles from "./privacy.module.css";

export function PrivacyControls() {
  const [revoked, setRevoked] = useState(false);

  return (
    <div className={styles.controlBox}>
      <div>
        <b>데모 AI 전송 동의 철회</b>
        <p>이 브라우저의 동의 플래그만 지웁니다. 다음 AI 요청 때 전송 범위를 다시 확인합니다.</p>
      </div>
      <button
        type="button"
        onClick={() => {
          revokeDemoAiConsent();
          setRevoked(true);
        }}
      >
        {revoked ? "철회됨" : "동의 철회"}
      </button>
    </div>
  );
}
