/// 호스트 능력 계약 (이슈 268).
///
/// ## 왜 이 파일이 있나
///
/// 엔진에 대해서는 우리가 이미 제대로 하고 있다 — `EngineAdapter` 34메서드 **하나**를 `WasmAdapter`(웹)와
/// `TauriAdapter`(데스크톱)가 각각 구현한다. 그런데 **호스트 능력**(파일 다이얼로그·드롭·창·테마·RPC)에는
/// 그 계약이 없었고, 그래서 셸마다 각자 구현했다. #260 이 그 대가였다 — OS 파일 열기 요청 처리가 한쪽
/// 셸에만 붙어서, 파일을 더블클릭해도 문서가 열리지 않았다.
///
/// ## 여기서 지키는 규율
///
/// **Tauri 를 얇게 미러링하지 않는다.** `getCurrentWebviewWindow().onDragDropEvent()` 를 그대로
/// 재수출하면 결합을 옮기기만 할 뿐이다. 아래 타입은 전부 **우리 의미**다 — 호스트가 바뀌어도 이 모양은
/// 유지된다. 구현체가 자기 SDK 모양을 여기에 맞춰 번역한다.
///
/// **못 하는 것은 못 한다고 말한다.** 브라우저는 창을 닫을 수 없고, OS 경로가 실린 드롭을 받을 수도
/// 없다(브라우저는 `File` 객체만 준다). 그걸 런타임 에러로 알게 하는 대신 `has()` 로 **묻게** 한다.

/** 호스트가 제공하거나 제공하지 않는 능력. UI 는 try/catch 가 아니라 이 이름으로 묻는다. */
export type Capability =
  /** 네이티브로 명령을 보낸다 (`invoke`). 이게 없으면 사실상 아무것도 못 한다. */
  | "rpc"
  /** 네이티브가 보내는 이벤트를 구독한다. */
  | "events"
  /** OS 파일 열기 대화상자 — **경로**를 돌려준다. */
  | "dialog.open"
  /** OS 파일 저장 대화상자 — **경로**를 돌려준다. */
  | "dialog.save"
  /** OS 테마(라이트/다크)를 읽고 변화를 구독한다. */
  | "theme"
  /** 창 위로 떨어뜨린 파일의 **OS 경로**를 받는다. */
  | "files.drop"
  /** 창을 닫는다. */
  | "window.close";

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  title?: string;
  multiple?: boolean;
  filters?: DialogFilter[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}

/** 구독 해제. 호스트마다 반환 모양이 달라서 여기서 함수 하나로 통일한다. */
export type Unlisten = () => void;

export type SystemTheme = "light" | "dark";

/// 파일 드롭 — 호스트 이벤트가 아니라 우리 의미로 좁힌 것.
///
/// 좌표는 **CSS 픽셀**이다. Tauri 가 물리 픽셀로 주는 것은 구현체가 `devicePixelRatio` 로 나눠서
/// 건넨다 — 호출자가 그 함정을 알 필요가 없어야 계약이다.
export type FileDropEvent =
  | { type: "enter"; paths: string[]; x: number; y: number }
  | { type: "over"; x: number; y: number }
  | { type: "leave" }
  | { type: "drop"; paths: string[]; x: number; y: number };

/// 호스트 능력의 계약. 셸이 이걸 구현하고, UI 는 이것만 안다.
export interface Platform {
  /** 진단·로그용 이름 ("tauri" / "web"). 분기 조건으로 쓰지 마라 — 그건 `has()` 가 할 일이다. */
  readonly name: string;

  /** 이 호스트가 해당 능력을 제공하는가. */
  has(capability: Capability): boolean;

  /** 네이티브 명령 호출. */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;

  /** 네이티브 이벤트 구독. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten>;

  /** 열 파일을 고른다. 취소하면 `null`. `multiple` 이면 배열. */
  pickFile(options?: OpenDialogOptions): Promise<string | string[] | null>;

  /** 저장 경로를 고른다. 취소하면 `null`. */
  pickSavePath(options?: SaveDialogOptions): Promise<string | null>;

  /** 현재 OS 테마. 모르면 `null` — 추측해서 돌려주지 않는다. */
  systemTheme(): Promise<SystemTheme | null>;

  /** OS 테마 변화 구독. */
  onThemeChanged(handler: (theme: SystemTheme) => void): Promise<Unlisten>;

  /** 창 위 파일 드롭 구독 (좌표는 CSS 픽셀). */
  onFileDrop(handler: (event: FileDropEvent) => void): Promise<Unlisten>;

  /** 창을 닫는다. */
  closeWindow(): Promise<void>;
}

/// 호스트가 그 능력을 제공하지 않을 때 던진다.
///
/// 이건 버그 신호다 — 올바른 UI 는 `has()` 로 먼저 묻고 그 경로를 아예 보여주지 않는다. 그래서 메시지가
/// 능력 이름과 호스트 이름을 모두 담는다: 조용히 삼켜지는 것보다 시끄럽게 실패하는 편이 고치기 쉽다.
export class CapabilityUnavailable extends Error {
  constructor(
    readonly capability: Capability,
    readonly platform: string,
  ) {
    super(`'${platform}' 호스트는 '${capability}' 능력을 제공하지 않는다`);
    this.name = "CapabilityUnavailable";
  }
}
