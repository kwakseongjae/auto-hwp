/// icons — the SDK's inline icon set.
///
/// ⚠️ 의도적으로 **의존성이 아니다**. lucide-react 를 dependency 로 넣으면 이 패키지를 임베드하는 모든
/// 호스트가 아이콘 라이브러리를 하나 더 끌어안게 된다(SDK 는 peer=react 둘뿐이라는 계약을 지킨다).
/// 그래서 필요한 글리프의 **path 데이터만** 옮겨 적는다.
///
/// 출처: lucide-react v1.28.0 — ISC License, Copyright (c) for portions of Lucide are held by
/// Cole Bemis 2013-2022 as part of Feather (MIT). 나머지는 Lucide Contributors 2022.
/// https://github.com/lucide-icons/lucide/blob/main/LICENSE
///
/// 규율(스크린샷 피드백 이슈 3): 텍스트 글리프(‹ › ↶ ↷ ✕ ☰ ◇ …)를 아이콘 자리에 쓰지 않는다 —
/// 폰트마다 크기·베이스라인이 제각각이라 정렬이 무너지고 저품질로 읽힌다. 여기 있는 것들은 전부
/// 24×24 viewBox · `stroke="currentColor"` · 기본 14px 라 버튼 안에서 같은 광학 크기로 앉는다.
import type { SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** 변 길이(px). 툴바/패널 버튼은 14, 조금 큰 표면은 16을 쓴다. */
  size?: number;
}

/** 공통 svg 껍데기 — 색은 currentColor(버튼의 color 를 그대로 따른다), 히트영역은 버튼이 소유한다. */
function makeIcon(name: string, body: React.ReactNode) {
  function Icon({ size = 14, className, strokeWidth = 2, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `hw-icon ${className}` : "hw-icon"}
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {body}
      </svg>
    );
  }
  Icon.displayName = `Icon(${name})`;
  return Icon;
}

// ── 방향/개폐 ────────────────────────────────────────────────────────────────────────────────────
export const ChevronLeft = makeIcon("ChevronLeft", <path d="m15 18-6-6 6-6" />);
export const ChevronRight = makeIcon("ChevronRight", <path d="m9 18 6-6-6-6" />);
export const ChevronUp = makeIcon("ChevronUp", <path d="m18 15-6-6-6 6" />);
export const ChevronDown = makeIcon("ChevronDown", <path d="m6 9 6 6 6-6" />);

export const PanelLeftClose = makeIcon(
  "PanelLeftClose",
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
    <path d="m16 15-3-3 3-3" />
  </>,
);
export const PanelLeftOpen = makeIcon(
  "PanelLeftOpen",
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
    <path d="m14 9 3 3-3 3" />
  </>,
);

export const X = makeIcon(
  "X",
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);

// ── 줌 ───────────────────────────────────────────────────────────────────────────────────────────
export const Minus = makeIcon("Minus", <path d="M5 12h14" />);
export const Plus = makeIcon(
  "Plus",
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
);

// ── 실행취소/다시실행 ────────────────────────────────────────────────────────────────────────────
export const Undo2 = makeIcon(
  "Undo2",
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
  </>,
);
export const Redo2 = makeIcon(
  "Redo2",
  <>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
  </>,
);

// ── 정렬(왼쪽/가운데/오른쪽/양쪽) ────────────────────────────────────────────────────────────────
export const AlignLeft = makeIcon(
  "AlignLeft",
  <>
    <path d="M21 5H3" />
    <path d="M15 12H3" />
    <path d="M17 19H3" />
  </>,
);
export const AlignCenter = makeIcon(
  "AlignCenter",
  <>
    <path d="M21 5H3" />
    <path d="M17 12H7" />
    <path d="M19 19H5" />
  </>,
);
export const AlignRight = makeIcon(
  "AlignRight",
  <>
    <path d="M21 5H3" />
    <path d="M21 12H9" />
    <path d="M21 19H7" />
  </>,
);
export const AlignJustify = makeIcon(
  "AlignJustify",
  <>
    <path d="M3 5h18" />
    <path d="M3 12h18" />
    <path d="M3 19h18" />
  </>,
);

// ── 편집/서식 ────────────────────────────────────────────────────────────────────────────────────
export const Pencil = makeIcon(
  "Pencil",
  <>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </>,
);
export const Bold = makeIcon("Bold", <path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" />);
export const PaintBucket = makeIcon(
  "PaintBucket",
  <>
    <path d="M11 7 6 2" />
    <path d="M18.992 12H2.041" />
    <path d="M21.145 18.38A3.34 3.34 0 0 1 20 16.5a3.3 3.3 0 0 1-1.145 1.88c-.575.46-.855 1.02-.855 1.595A2 2 0 0 0 20 22a2 2 0 0 0 2-2.025c0-.58-.285-1.13-.855-1.595" />
    <path d="m8.5 4.5 2.148-2.148a1.205 1.205 0 0 1 1.704 0l7.296 7.296a1.205 1.205 0 0 1 0 1.704l-7.592 7.592a3.615 3.615 0 0 1-5.112 0l-3.888-3.888a3.615 3.615 0 0 1 0-5.112L5.67 7.33" />
  </>,
);
export const MoveHorizontal = makeIcon(
  "MoveHorizontal",
  <>
    <path d="m18 8 4 4-4 4" />
    <path d="M2 12h20" />
    <path d="m6 8-4 4 4 4" />
  </>,
);
export const ArrowUpToLine = makeIcon(
  "ArrowUpToLine",
  <>
    <path d="M5 3h14" />
    <path d="m18 13-6-6-6 6" />
    <path d="M12 7v14" />
  </>,
);
export const ArrowDownToLine = makeIcon(
  "ArrowDownToLine",
  <>
    <path d="M12 17V3" />
    <path d="m6 11 6 6 6-6" />
    <path d="M19 21H5" />
  </>,
);
export const TableIcon = makeIcon(
  "Table",
  <>
    <path d="M12 3v18" />
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M3 9h18" />
    <path d="M3 15h18" />
  </>,
);

// ── AI/선택/첨부 ─────────────────────────────────────────────────────────────────────────────────
export const Sparkles = makeIcon(
  "Sparkles",
  <>
    <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
    <path d="M20 2v4" />
    <path d="M22 4h-4" />
    <circle cx="4" cy="20" r="2" />
  </>,
);
export const MousePointerClick = makeIcon(
  "MousePointerClick",
  <>
    <path d="M14 4.1 12 6" />
    <path d="m5.1 8-2.9-.8" />
    <path d="m6 12-1.9 2" />
    <path d="M7.2 2.2 8 5.1" />
    <path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" />
  </>,
);
export const FileText = makeIcon(
  "FileText",
  <>
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </>,
);
export const Crosshair = makeIcon(
  "Crosshair",
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M22 12h-4" />
    <path d="M6 12H2" />
    <path d="M12 6V2" />
    <path d="M12 22v-4" />
  </>,
);
