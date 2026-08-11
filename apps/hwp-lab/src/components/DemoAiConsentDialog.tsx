"use client";

import { ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import styles from "./DemoAiConsentDialog.module.css";
import { siteHref } from "./site/paths";

/** 데모 AI 전송 동의 모달 — 네이티브 `window.confirm` 의 대체.
 *
 *  왜 바꿨나: confirm 은 ① 브라우저 크롬으로 뜨는 시스템 UI라 "우리 제품이 하는 말"로 읽히지 않고
 *  ② 스타일/줄바꿈을 통제할 수 없으며 ③ 메인스레드를 통째로 멈춘다(엔진 워커 진행률·자동저장까지).
 *
 *  문구는 **한 글자도 새로 쓰지 않는다**: `lib/demoAiConsent.ts` 의 상수(전송 대상·중계 경로·되돌리기)
 *  를 그대로 문단으로 받아 렌더한다(paragraphs). 프라이버시 계약은 그 파일 하나가 정본이다.
 *
 *  기본기만 갖춘 접근성(과한 의존성 없이): role=dialog + aria-modal, 열릴 때 기본 버튼 포커스,
 *  Tab 순환 가둠, Esc = 거부, 배경 클릭 = 거부, 닫힐 때 직전 포커스 복원. */
export interface DemoAiConsentDialogProps {
  open: boolean;
  /** 동의 문구 문단들(demoAiConsentParagraphs). 마지막 문단이 질문이다. */
  paragraphs: readonly string[];
  onAccept: () => void;
  onDecline: () => void;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function DemoAiConsentDialog({ open, paragraphs, onAccept, onDecline }: DemoAiConsentDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  // 열기 직전 포커스를 쥐고 있던 요소(보통 채팅 입력창) — 닫으면 그 자리로 되돌려 준다.
  const restoreRef = useRef<HTMLElement | null>(null);

  // 최신 콜백을 이벤트 핸들러가 보게 한다(effect 를 콜백 정체성에 매달지 않는다 —
  // 부모가 인라인 화살표 함수를 넘겨도 리스너가 매 렌더 재등록되지 않는다).
  // ⚠️ 이 effect 는 아래 키보드 effect보다 **먼저 선언**돼 있어야 한다(실행 순서 = 선언 순서).
  const declineRef = useRef(onDecline);
  useEffect(() => {
    declineRef.current = onDecline;
  }, [onDecline]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    acceptRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        declineRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("disabled"));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // 포커스가 모달 밖으로 새면(브라우저 크롬/배경 페이지) 다시 안으로 당겨 온다.
      if (!root.contains(active instanceof Node ? active : null)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus?.();
      restoreRef.current = null;
    };
  }, [open]);

  const onBackdrop = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // 배경(모달 바깥)만 — 다이얼로그 내부 클릭이 버블링으로 닫지 않도록.
      if (e.target === e.currentTarget) onDecline();
    },
    [onDecline],
  );

  if (!open) return null;

  return (
    <div className={styles.backdrop} onMouseDown={onBackdrop} data-testid="demo-ai-consent-backdrop">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-ai-consent-title"
        aria-describedby="demo-ai-consent-body"
        data-testid="demo-ai-consent"
      >
        <div className={styles.head}>
          <span className={styles.icon} aria-hidden>
            <ShieldCheck size={16} />
          </span>
          <h2 className={styles.title} id="demo-ai-consent-title">
            AI 편집 전 전송 동의
          </h2>
          <button type="button" className={styles.close} onClick={onDecline} aria-label="닫기(전송하지 않음)" data-testid="demo-ai-consent-close">
            <X size={15} />
          </button>
        </div>

        <div className={styles.body} id="demo-ai-consent-body">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>

        {/* 영속 사실의 고지 — 저장되는 것은 "동의했다"는 사실뿐이고, 그 사실이 이 브라우저에 남는다. */}
        <p className={styles.note}>
          동의하면 이 브라우저에 한 번만 기억되고 다음부터는 묻지 않습니다.{" "}
          <a href={siteHref("/privacy")}>전송·보유 범위와 동의 철회 보기</a>
        </p>

        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={onDecline} data-testid="demo-ai-consent-decline">
            보내지 않음
          </button>
          <button
            ref={acceptRef}
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={onAccept}
            data-testid="demo-ai-consent-accept"
          >
            동의하고 전송
          </button>
        </div>
      </div>
    </div>
  );
}
