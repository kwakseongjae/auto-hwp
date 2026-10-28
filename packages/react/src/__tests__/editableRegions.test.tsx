import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { regionScopes, resolveEditableRegions } from "../components/EditableRegionsLayer";
import type { EditTarget } from "@auto-hwp/editor-core";
import type { BlockHit, CellBoxItem } from "../types";
import { MockAdapter } from "./mockAdapter";

// #511 — showEditableRegions: 편집 정책이 참인 칸 · 빈 문단을 엔진 오버레이 층에 그린다.
// 계약: ① 정책이 참인 영역만 ② 켬/끔 · 범위 ③ regionClass(null = 그리지 않음) ④ 쪽 그림 · 캐럿을 막지 않는다(측정은 효과 안에서 비동기,
// 결과 전에는 이전 영역 유지) ⑤ 문서(refreshToken) · 정책이 바뀌면 다시 재고 낡은 결과는 버린다 ⑥ 어댑터에 cellBoxes 가 없어도 문단 표시는 동작.

const cellItem = (row: number, col: number, over: Partial<CellBoxItem> = {}): CellBoxItem => ({
  section: 0,
  block: 5,
  row,
  col,
  path: [{ block: 5, row, col }],
  text: "글",
  x: 100,
  y: 100 + row * 40,
  w: 200,
  h: 30,
  ...over,
});
const para = (block: number, y: number, text: string, over: Partial<BlockHit> = {}): BlockHit => ({
  section: 0,
  block,
  kind: "paragraph",
  x: 75,
  y,
  w: 640,
  h: 20,
  text,
  editable: true,
  ...over,
});
const only =
  (...allowed: Array<(t: EditTarget) => boolean>) =>
  (t: EditTarget) =>
    allowed.some((f) => f(t));
const isCell = (row: number, col: number) => (t: EditTarget) =>
  t.kind === "cell" && t.row === row && t.col === col;
const isPara = (block: number) => (t: EditTarget) => t.kind === "paragraph" && t.block === block;

describe("regionScopes", () => {
  it("true = 칸 + 빈 문단, 문자열 · 배열 = 그 범위, false · undefined = 끔", () => {
    expect([...regionScopes(true)].sort()).toEqual(["cells", "emptyParagraphs"])
    expect([...regionScopes("all")]).toEqual(["all"])
    expect([...regionScopes(["cells"])]).toEqual(["cells"])
    expect(regionScopes(false).size).toBe(0)
    expect(regionScopes(undefined).size).toBe(0)
  })
})

describe("resolveEditableRegions (순수)", () => {
  const adapter = new MockAdapter({
    cellBoxes: [cellItem(0, 0), cellItem(0, 1, { text: "" }), cellItem(1, 0, { path: [{ block: 5, row: 0, col: 0 }, { block: 0, row: 1, col: 0 }] })],
    blocks: [para(1, 10, ""), para(2, 40, "본문 글"), { ...para(3, 70, ""), kind: "table" }, para(4, 100, "", { h: 0 })],
  });

  it("정책이 참인 칸만 · 중첩 칸은 path 를 실어 묻는다", async () => {
    const asked: EditTarget[] = [];
    const regions = await resolveEditableRegions({
      adapter,
      page: 0,
      scopes: regionScopes("cells"),
      canEdit: (t) => (asked.push(t), isCell(0, 1)(t)),
    });
    expect(regions.map((r) => [r.kind, r.box.x])).toEqual([["cell", 100]]);
    expect(regions[0].text).toBe("")
    const nested = asked.find((t) => t.kind === "cell" && t.row === 1 && t.col === 0)
    expect(nested && "path" in nested && nested.path?.length).toBe(2)
    expect(asked.every((t) => t.kind === "cell" && t.intent === "SetTableCellRuns")).toBe(true)
  })

  it("emptyParagraphs = 글 없는 편집 가능 문단만(표 · 높이 0 제외), all = 글 있는 문단도", async () => {
    const empties = await resolveEditableRegions({ adapter, page: 0, scopes: regionScopes("emptyParagraphs"), canEdit: () => true })
    expect(empties.map((r) => (r.target as { block: number }).block)).toEqual([1])
    const all = await resolveEditableRegions({ adapter, page: 0, scopes: regionScopes("all"), canEdit: only(isPara(2), isCell(0, 0)) })
    expect(all.map((r) => r.kind).sort()).toEqual(["cell", "paragraph"])
  })

  it("regionClass: 문자열은 덧붙고 null 은 그리지 않는다", async () => {
    const regions = await resolveEditableRegions({
      adapter,
      page: 0,
      scopes: regionScopes("cells"),
      canEdit: () => true,
      regionClass: (r) => (r.text === "" ? null : "bpk-x"),
    })
    expect(regions.map((r) => r.className)).toEqual(["bpk-x", "bpk-x"])
  })

  it("엔진이 캐럿을 못 놓는 문단(editable:false)은 정책이 허용해도 표시하지 않는다", async () => {
    const a = new MockAdapter({ blocks: [para(1, 10, "", { editable: false }), para(2, 40, "")] })
    const regions = await resolveEditableRegions({ adapter: a, page: 0, scopes: regionScopes("emptyParagraphs"), canEdit: () => true })
    expect(regions.map((r) => (r.target as { block: number }).block)).toEqual([2])
  })

  it("cellBoxes 가 없는 어댑터는 칸만 빠지고 문단은 나온다", async () => {
    const noCells = new MockAdapter({ blocks: [para(1, 10, "")] })
    const regions = await resolveEditableRegions({ adapter: noCells, page: 0, scopes: regionScopes(true), canEdit: () => true })
    expect(regions.map((r) => r.kind)).toEqual(["paragraph"])
  })
})

const renderWs = (adapter: MockAdapter, props: Partial<React.ComponentProps<typeof HwpWorkspace>> = {}) =>
  render(
    <HwpWorkspace
      adapter={adapter}
      document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }}
      onAiRequest={async () => []}
      enableEditing
      {...props}
    />,
  )
const regionsIn = (c: HTMLElement) => Array.from(c.querySelectorAll(".hw-region"))

describe("HwpWorkspace showEditableRegions", () => {
  const make = () =>
    new MockAdapter({
      cellBoxes: [cellItem(0, 0), cellItem(0, 1, { text: "" })],
      blocks: [para(1, 300, "")],
    })

  it("끔(기본)이면 그리지 않고 측정도 하지 않는다", async () => {
    const adapter = make()
    const { container } = renderWs(adapter)
    await waitFor(() => expect(container.querySelector('.hw-sheet[data-page="0"] svg')).toBeTruthy())
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    expect(regionsIn(container)).toHaveLength(0)
    expect(adapter.cellBoxCalls).toBe(0)
  })

  it("켜면 정책이 참인 영역을 그리고(빈 것은 hw-region-empty), 층은 클릭을 막지 않는다", async () => {
    const adapter = make()
    const { container } = renderWs(adapter, { showEditableRegions: true, editable: only(isCell(0, 1), isPara(1)) })
    await waitFor(() => expect(regionsIn(container).length).toBe(2), { timeout: 3000 })
    const kinds = regionsIn(container).map((e) => e.className)
    expect(kinds.every((c) => /hw-region-empty/.test(c))).toBe(true)
    expect(container.querySelector(".hw-regions")).toBeTruthy()
    // 표시 층 자체는 pointer-events:none 이다(스타일시트 규칙 — 인라인이 아니라 CSS)
    const layer = container.querySelector(".hw-regions") as HTMLElement
    expect(layer.getAttribute("aria-hidden")).toBe("true")
  })

  it("범위: cells 만이면 문단을 그리지 않는다", async () => {
    const adapter = make()
    const { container } = renderWs(adapter, { showEditableRegions: "cells" })
    await waitFor(() => expect(regionsIn(container).length).toBe(2), { timeout: 3000 })
    expect(regionsIn(container).every((e) => e.classList.contains("hw-region-cell"))).toBe(true)
  })

  it("정책이 바뀌면(editable 새 함수) 다시 재고 낡은 결과는 버린다", async () => {
    const adapter = make()
    const first = only(isCell(0, 0), isCell(0, 1))
    const second = only(isCell(0, 1))
    const { container, rerender } = renderWs(adapter, { showEditableRegions: "cells", editable: first })
    await waitFor(() => expect(regionsIn(container).length).toBe(2), { timeout: 3000 })
    const calls = adapter.cellBoxCalls
    rerender(
      <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} enableEditing showEditableRegions="cells" editable={second} />,
    )
    await waitFor(() => expect(regionsIn(container).length).toBe(1), { timeout: 3000 })
    expect(adapter.cellBoxCalls).toBeGreaterThan(calls)
  })

  it("측정이 느려도 쪽 그림은 이미 나와 있다(막지 않는다) · 결과가 오기 전 이전 영역을 유지한다", async () => {
    let release: (() => void) | null = null
    const base = make()
    const slow = Object.assign(Object.create(base) as MockAdapter, {
      cellBoxes: vi.fn(
        () => new Promise<CellBoxItem[]>((resolve) => {
          release = () => resolve([cellItem(0, 0)])
        }),
      ),
    })
    const { container } = renderWs(slow, { showEditableRegions: "cells" })
    // 측정이 끝나지 않아도 쪽 SVG 는 그려진다
    await waitFor(() => expect(container.querySelector('.hw-sheet[data-page="0"] svg')).toBeTruthy())
    expect(regionsIn(container)).toHaveLength(0)
    await waitFor(() => expect(release).not.toBeNull(), { timeout: 3000 })
    await act(async () => { release?.() })
    await waitFor(() => expect(regionsIn(container).length).toBe(1))
  })
})

import { EditableRegionsLayer } from "../components/EditableRegionsLayer"
import type { EngineAdapter } from "@auto-hwp/editor-core"

describe("EditableRegionsLayer — 문서 버전(token) 무효화 · 낡은 결과 폐기 (#511)", () => {
  const setup = () => {
    const pending: Array<(items: CellBoxItem[]) => void> = []
    const adapter = {
      cellBoxes: vi.fn(() => new Promise<CellBoxItem[]>((resolve) => pending.push(resolve))),
    } as unknown as EngineAdapter
    const scopes = regionScopes("cells")
    const mount = (token: number) => (
      <EditableRegionsLayer adapter={adapter} page={0} scale={1} scopes={scopes} canEdit={() => true} token={token} policyKey="p" />
    )
    return { adapter, pending, scopes, mount }
  }
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 120)) })

  it("token 이 바뀌면 다시 재고, 늦게 도착한 옛 결과가 새 결과를 덮지 않는다", async () => {
    const { adapter, pending, mount } = setup()
    const { container, rerender } = render(mount(1))
    await settle()
    expect((adapter.cellBoxes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    rerender(mount(2)) // 문서가 바뀜(쓰기 · 실행취소 · 확정)
    await settle()
    expect((adapter.cellBoxes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    // 새 측정(token 2)이 먼저 끝나고, 옛 측정(token 1)이 뒤늦게 끝난다
    await act(async () => { pending[1]([cellItem(0, 0, { x: 50 })]) })
    await waitFor(() => expect(container.querySelectorAll(".hw-region").length).toBe(1))
    await act(async () => { pending[0]([cellItem(0, 0), cellItem(0, 1), cellItem(1, 0)]) })
    await settle()
    expect(container.querySelectorAll(".hw-region").length).toBe(1)
    expect((container.querySelector(".hw-region") as HTMLElement).style.left).toBe("50px")
  })

  it("연타(같은 80ms 안의 token 변화)는 한 번의 측정으로 묶인다", async () => {
    const { adapter, mount } = setup()
    const { rerender } = render(mount(1))
    rerender(mount(2))
    rerender(mount(3))
    await settle()
    expect((adapter.cellBoxes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("결과가 오기 전에는 이전 영역을 그대로 둔다(깜박임 없음)", async () => {
    const { pending, mount } = setup()
    const { container, rerender } = render(mount(1))
    await settle()
    await act(async () => { pending[0]([cellItem(0, 0)]) })
    await waitFor(() => expect(container.querySelectorAll(".hw-region").length).toBe(1))
    rerender(mount(2))
    await settle() // 새 측정이 진행 중
    expect(container.querySelectorAll(".hw-region").length).toBe(1)
  })
})

describe("EditableRegionsLayer — 가상화 · 칸이 품은 것 · 렌더 밖 측정 (#511 리뷰 반영)", () => {
  it("그려지지 않은 쪽(visible=false)은 재지 않고 그리지 않으며, 보이게 되면 잰다", async () => {
    const calls = vi.fn(async () => [cellItem(0, 0)])
    const adapter = { cellBoxes: calls } as unknown as EngineAdapter
    const scopes = regionScopes("cells")
    const el = (visible: boolean) => (
      <EditableRegionsLayer adapter={adapter} page={3} scale={1} visible={visible} scopes={scopes} canEdit={() => true} token={1} policyKey="p" />
    )
    const { container, rerender } = render(el(false))
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(calls).not.toHaveBeenCalled()
    expect(container.querySelector(".hw-region")).toBeNull()
    rerender(el(true))
    await waitFor(() => expect(container.querySelectorAll(".hw-region").length).toBe(1))
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it("글이 없어도 안쪽 표 · 그림을 품은 칸(objects)은 빈 칸으로 칠하지 않는다", async () => {
    const adapter = { cellBoxes: async () => [cellItem(0, 0, { text: "", objects: true }), cellItem(0, 1, { text: "" })] } as unknown as EngineAdapter
    const { container } = render(
      <EditableRegionsLayer adapter={adapter} page={0} scale={1} scopes={regionScopes("cells")} canEdit={() => true} token={1} policyKey="p" />,
    )
    await waitFor(() => expect(container.querySelectorAll(".hw-region").length).toBe(2))
    const empties = Array.from(container.querySelectorAll(".hw-region")).map((e) => e.classList.contains("hw-region-empty"))
    expect(empties).toEqual([false, true])
  })

  it("측정은 렌더 중이 아니라 효과 뒤(디바운스 뒤)에 시작한다 — 마운트 직후에는 아직 호출이 없다", async () => {
    const calls = vi.fn(async () => [cellItem(0, 0)])
    const adapter = { cellBoxes: calls } as unknown as EngineAdapter
    render(<EditableRegionsLayer adapter={adapter} page={0} scale={1} scopes={regionScopes("cells")} canEdit={() => true} token={1} policyKey="p" />)
    expect(calls).not.toHaveBeenCalled() // 렌더 · 커밋 직후 — 캐럿 · 그리기 경로에 측정이 끼지 않는다
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
  })

  it("regionClass 참조가 바뀌면 다시 잰다", async () => {
    const calls = vi.fn(async () => [cellItem(0, 0)])
    const adapter = { cellBoxes: calls } as unknown as EngineAdapter
    const scopes = regionScopes("cells")
    const el = (rc: (r: unknown) => string | null) => (
      <EditableRegionsLayer adapter={adapter} page={0} scale={1} scopes={scopes} canEdit={() => true} token={1} policyKey="p" regionClass={rc as never} />
    )
    const { container, rerender } = render(el(() => "a"))
    await waitFor(() => expect(container.querySelector(".hw-region.a")).toBeTruthy())
    rerender(el(() => "b"))
    await waitFor(() => expect(container.querySelector(".hw-region.b")).toBeTruthy())
    expect(calls).toHaveBeenCalledTimes(2)
  })
})

describe("HwpWorkspace — 문서가 바뀌면(적용) 영역을 다시 잰다 (#511)", () => {
  it("side panel 의 apply 한 번 뒤 cellBoxes 가 다시 불린다", async () => {
    const adapter = new MockAdapter({ cellBoxes: [cellItem(0, 0)] })
    let api: { apply: (i: unknown[]) => Promise<number> } | null = null
    const { container } = render(
      <HwpWorkspace
        adapter={adapter}
        document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }}
        onAiRequest={async () => []}
        enableEditing
        showEditableRegions="cells"
        sidePanel={(a) => { api = a as never; return null }}
      />,
    )
    await waitFor(() => expect(container.querySelectorAll(".hw-region").length).toBe(1), { timeout: 3000 })
    const before = adapter.cellBoxCalls
    await act(async () => {
      await api!.apply([{ intent: "SetTableCellRuns", section: 0, index: 5, row: 0, col: 0, runs: [{ text: "x" }] }])
    })
    await waitFor(() => expect(adapter.cellBoxCalls).toBeGreaterThan(before), { timeout: 3000 })
  })
})
