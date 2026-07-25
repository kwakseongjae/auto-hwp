// 캐럿 라우터 — 표 셀 캐럿(053)과 본문 문단 캐럿을 **하나의 표면**으로 합친다.
//
// 왜 필요한가: 캐럿을 그리는 오버레이(CaretLayer)와 IME 조합 표면(ImeCompositionLayer), 그리고 타이핑
// keydown은 "지금 캐럿이 어디 있고 무엇에 커밋하는가"만 알면 된다. 그 분기를 UI 세 곳에 복제하는 대신
// 여기 한 곳에 둔다(오버레이는 여전히 store를 직접 구독 — props로 흘려받지 않는다).
//
// 불변식: 두 캐럿은 **동시에 살 수 없다**. 한쪽이 잡히면 다른 쪽은 즉시 해제된다(한 문서에 캐럿 하나).

import type { BodyCaretController } from "./bodyCaret";
import type { CellCaretController } from "./cellCaret";
import { Emitter } from "./events";
import type { RunStyle } from "./runs";
import type { CellCaretRect } from "./types";

/** 어느 편집 표면의 캐럿인가 — 방향키 경계 동작이 갈린다(셀은 셀 이동으로 강등, 본문은 줄 이동). */
export type CaretKind = "cell" | "body";

/** 지금 살아 있는 캐럿의 UI 계약: 그릴 기하 + 경계 판정에 필요한 오프셋/길이 + 출처. */
export interface ActiveCaret {
  kind: CaretKind;
  rect: CellCaretRect;
  offset: number;
  paraLen: number;
}

/// CaretRouter — 두 컨트롤러의 상태를 합쳐 하나의 `onChange` 스트림으로 내보내고, 명령(이동/입력/삭제)을
/// 살아 있는 쪽으로 라우팅한다. 자체 상태는 파생값뿐이라 진실은 항상 각 컨트롤러에 있다.
export class CaretRouter {
  private active: CaretKind | null = null;
  private state: ActiveCaret | null = null;
  private changed = new Emitter<ActiveCaret | null>();

  constructor(
    private cell: CellCaretController,
    private body: BodyCaretController,
  ) {
    this.cell.onChange((s) =>
      this.absorb("cell", s && { kind: "cell" as const, rect: s.rect, offset: s.anchor.offset, paraLen: s.anchor.paraLen }),
    );
    this.body.onChange((s) =>
      this.absorb("body", s && { kind: "body" as const, rect: s.rect, offset: s.anchor.offset, paraLen: s.anchor.paraLen }),
    );
  }

  /** 어느 한쪽이라도 답할 수 있으면 캐럿 기능이 켜진 것이다(018: 없는 메서드 = 기능 off). */
  get supported(): boolean {
    return this.cell.supported || this.body.supported;
  }

  get(): ActiveCaret | null {
    return this.state;
  }

  onChange(l: (s: ActiveCaret | null) => void): () => void {
    return this.changed.on(l);
  }

  /** 두 캐럿 모두 해제(Escape / 문서 교체 / 이미지 선택 등). */
  clear(): void {
    this.cell.clear();
    this.body.clear();
  }

  /** 클릭 해소 순서: **셀 먼저**(표 안이 우선 — 기존 053 동작 무회귀), 셀이 아니면 본문 문단. */
  async clickAt(page: number, x: number, y: number): Promise<ActiveCaret | null> {
    const inCell = await this.cell.clickAt(page, x, y);
    if (inCell) return this.state;
    const inBody = await this.body.clickAt(page, x, y);
    return inBody ? this.state : null;
  }

  /** 좌우 이동(문단/셀 문단 안). 살아 있는 캐럿이 없으면 no-op. */
  async move(delta: number): Promise<void> {
    if (this.active === "cell") await this.cell.move(delta);
    else if (this.active === "body") await this.body.move(delta);
  }

  /** 위/아래 줄 이동 — **본문 캐럿 전용**(셀은 036 셀 이동으로 강등되는 기존 동작을 지킨다).
   *  처리했으면 true(호출자가 기본동작을 막는다), 아니면 false(호출자가 셀 이동으로 넘긴다). */
  async moveLine(delta: number): Promise<boolean> {
    if (this.active !== "body") return false;
    await this.body.moveLine(delta);
    return true;
  }

  async insertText(text: string): Promise<boolean> {
    if (this.active === "cell") return this.cell.insertText(text);
    if (this.active === "body") return this.body.insertText(text);
    return false;
  }

  async deleteBack(): Promise<boolean> {
    if (this.active === "cell") return this.cell.deleteBack();
    if (this.active === "body") return this.body.deleteBack();
    return false;
  }

  /** 캐럿 자리의 런 스타일(059 IME 미리보기). 읽기 전용 — 캐럿을 건드리지 않는다. */
  async styleAtCaret(): Promise<RunStyle | null> {
    if (this.active === "cell") return this.cell.styleAtCaret();
    if (this.active === "body") return this.body.styleAtCaret();
    return null;
  }

  /** 한쪽 컨트롤러의 상태 변화를 흡수한다. 비활성 쪽의 `null`은 **무시**(상호 배제 해제가 살아 있는
   *  캐럿을 지우지 못하게 — 플리커/유실 방지). */
  private absorb(kind: CaretKind, next: ActiveCaret | null): void {
    if (next) {
      const other = this.active && this.active !== kind ? this.active : null;
      this.active = kind;
      this.state = next;
      if (other) (other === "cell" ? this.cell : this.body).clear(); // 상호 배제 (그 clear는 위 규칙으로 무시된다)
      this.changed.emit(this.state);
      return;
    }
    if (this.active !== kind) return;
    this.active = null;
    this.state = null;
    this.changed.emit(null);
  }
}
