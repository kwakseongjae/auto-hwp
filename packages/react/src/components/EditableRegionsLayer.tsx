import { useEffect, useMemo, useRef, useState } from "react";
import type { EditTarget, EngineAdapter } from "@auto-hwp/editor-core";

/// 편집 가능 영역 표시 (#511) — 호스트의 편집 정책(`editable`)이 참인 칸 · 빈 문단을 엔진 오버레이 층에 옅게 그린다.
/// 호스트가 SVG 를 고치거나 엔진 DOM 위에 겹쳐 그리지 않아도 「어디가 쓰는 곳인가」가 보인다.

/** 표시할 범위. `cells` = 정책이 참인 표 칸, `emptyParagraphs` = 글이 없는 편집 가능 문단(빈 줄), `all` = 칸 + 모든 편집 가능 문단 */
export type EditableRegionScope = "cells" | "emptyParagraphs" | "all";

/** `showEditableRegions` 값 — `true` = 칸 + 빈 문단 */
export type ShowEditableRegions = boolean | EditableRegionScope | readonly EditableRegionScope[];

export interface EditableRegion {
  kind: "cell" | "paragraph";
  /** 정책에 물은 타깃 그대로(호스트가 `regionClass` 에서 칸 · 문단을 알아본다) */
  target: EditTarget;
  /** 칸 · 문단의 현재 글(평문) */
  text: string;
  /** 칸이 글이 아닌 것(안쪽 표 · 그림 …)을 품고 있다 — 글이 없어도 「빈 칸」이 아니다. 문단은 항상 false */
  objects: boolean;
  /** own-render PAGE px */
  box: { x: number; y: number; w: number; h: number };
}

/** 영역마다 클래스를 덧붙인다(`string`) · 그리지 않는다(`null`). 예: 호스트의 「빈 칸」 판정 */
export type RegionClass = (region: EditableRegion) => string | null;

/** `showEditableRegions` → 켜진 범위(없으면 빈 집합 = 끔) */
export function regionScopes(show: ShowEditableRegions | undefined): ReadonlySet<EditableRegionScope> {
  if (show === undefined || show === false) return new Set();
  if (show === true) return new Set<EditableRegionScope>(["cells", "emptyParagraphs"]);
  return new Set<EditableRegionScope>(typeof show === "string" ? [show] : show);
}

const PAGE_EXTENT = 100_000; // blocksInRect 는 쪽을 넘는 사각형을 쪽에 맞춰 자른다 — 쪽 전체

/// 한 쪽의 영역을 잰다 — 순수(어댑터 · 정책만 본다). 어댑터에 `cellBoxes` / `blocksInRect` 가 없으면 그 범위만 빠진다.
export async function resolveEditableRegions(args: {
  adapter: Pick<EngineAdapter, "cellBoxes" | "blocksInRect">;
  page: number;
  scopes: ReadonlySet<EditableRegionScope>;
  canEdit: (target: EditTarget) => boolean;
  regionClass?: RegionClass;
}): Promise<Array<EditableRegion & { className: string }>> {
  const { adapter, page, scopes, canEdit, regionClass } = args;
  const out: Array<EditableRegion & { className: string }> = [];
  const push = (region: EditableRegion) => {
    const extra = regionClass ? regionClass(region) : "";
    if (extra === null) return;
    out.push({ ...region, className: extra });
  };
  if ((scopes.has("cells") || scopes.has("all")) && typeof adapter.cellBoxes === "function") {
    for (const cell of await adapter.cellBoxes(page)) {
      if (!(cell.w > 0 && cell.h > 0)) continue;
      const nested = cell.path.length >= 2;
      const target: EditTarget = nested
        ? { kind: "cell", section: cell.section, block: cell.block, row: cell.row, col: cell.col, path: cell.path, intent: "SetTableCellRuns" }
        : { kind: "cell", section: cell.section, block: cell.block, row: cell.row, col: cell.col, intent: "SetTableCellRuns" };
      if (!canEdit(target)) continue;
      push({ kind: "cell", target, text: cell.text, objects: cell.objects === true, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h } });
    }
  }
  const wantsEmpty = scopes.has("emptyParagraphs");
  const wantsAll = scopes.has("all");
  if ((wantsEmpty || wantsAll) && typeof adapter.blocksInRect === "function") {
    for (const hit of await adapter.blocksInRect(page, 0, 0, PAGE_EXTENT, PAGE_EXTENT)) {
      // 엔진이 캐럿을 못 놓는 문단(구역 첫 문단처럼 글이 아닌 것을 품은 문단)은 정책이 허용해도 표시하지 않는다 — 눌러도 캐럿이 안 선다
      if (hit.kind !== "paragraph" || !hit.editable || !(hit.h > 1)) continue;
      const empty = hit.text.trim().length === 0;
      if (!wantsAll && !empty) continue;
      const target: EditTarget = { kind: "paragraph", section: hit.section, block: hit.block, intent: "SetParagraphRuns" };
      if (!canEdit(target)) continue;
      push({ kind: "paragraph", target, text: hit.text, objects: false, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h } });
    }
  }
  return out;
}

export interface EditableRegionsLayerProps {
  adapter: EngineAdapter;
  page: number;
  /** rendered px / viewBox px for this page */
  scale: number;
  /** 가상화로 쪽 그림이 그려진 쪽인가 — 아니면 재지 않고 그리지도 않는다(큰 문서에서 전 쪽 측정이 워커를 막지 않게) */
  visible?: boolean;
  scopes: ReadonlySet<EditableRegionScope>;
  /** 정책 질의 — 최신 함수를 ref 로 읽는다(렌더마다 새 함수여도 다시 재지 않는다) */
  canEdit: (target: EditTarget) => boolean;
  /** 문서가 바뀔 때마다 바뀌는 값(`refreshToken` — 쓰기 · 실행취소 · 확정) */
  token: number;
  /** 정책이 바뀌었음을 알리는 값(워크스페이스의 `editabilityEpoch` — 호스트가 `editable` 에 새 함수를 주거나 `invalidateEditability()` 를 부르면 바뀐다) */
  policyKey: unknown;
  regionClass?: RegionClass;
}

/** 연타(타자)를 한 번의 측정으로 묶는 지연(ms) */
const SETTLE_MS = 80;

/// EditableRegionsLayer — pointer-events:none 의 순수 표시 층(FindMatchOverlay 쌍둥이). **쪽 그림 · 캐럿을 막지 않는다**: 측정은 렌더 밖(효과)에서
/// 비동기로 하고, 결과가 오기 전에는 이전 영역을 그대로 둔다(깜박임 없음). 문서 · 정책이 바뀌면 다시 재고 낡은 결과는 버린다.
export function EditableRegionsLayer(props: EditableRegionsLayerProps) {
  const { adapter, page, scale, scopes, token, policyKey, regionClass } = props;
  const visible = props.visible !== false;
  const [regions, setRegions] = useState<Array<EditableRegion & { className: string }>>([]);
  const canEditRef = useRef(props.canEdit);
  canEditRef.current = props.canEdit;
  const scopeKey = useMemo(() => [...scopes].sort().join(","), [scopes]);

  useEffect(() => {
    if (scopes.size === 0) {
      setRegions((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // 그려지지 않은 쪽(가상화 플레이스홀더)은 재지 않는다 — 보이게 되면 이 효과가 다시 돌아 잰다
    if (!visible) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      resolveEditableRegions({ adapter, page, scopes, canEdit: (t) => canEditRef.current(t), regionClass })
        .then((next) => {
          if (!cancelled) setRegions(next);
        })
        .catch(() => {
          // 표시만 빠진다 — 편집 · 그리기는 그대로
        });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // scopes 는 scopeKey 로 본다(집합 정체성이 렌더마다 달라도 다시 재지 않게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, page, token, policyKey, scopeKey, visible, regionClass]);

  if (scopes.size === 0 || !visible || regions.length === 0) return null;
  return (
    <div className="hw-regions" aria-hidden data-testid="hw-regions">
      {regions.map((r, i) => (
        <div
          key={`${r.kind}:${r.target.kind === "cell" ? `${r.target.block}.${r.target.row}.${r.target.col}.${r.target.path?.length ?? 1}` : `p${(r.target as { block: number }).block}`}:${i}`}
          className={`hw-region hw-region-${r.kind}${r.text.trim().length === 0 && !r.objects ? " hw-region-empty" : ""}${r.className ? ` ${r.className}` : ""}`}
          style={{ left: r.box.x * scale, top: r.box.y * scale, width: r.box.w * scale, height: r.box.h * scale }}
        />
      ))}
    </div>
  );
}
