/// Tauri 호스트 구현 (이슈 268).
///
/// ★ **이 저장소에서 `@tauri-apps/*` 를 import 해도 되는 유일한 파일이다.** 그게 이 패키지의 존재
/// 이유 전부다. `src/platform-boundary.test.ts` 가 이 규칙을 강제한다 — 지키지 못할 규칙은 규칙이
/// 아니기 때문이다.
///
/// 여기서 하는 일은 번역이다: Tauri 의 모양을 우리 계약(`types.ts`)의 모양으로 바꾼다. 호스트 고유의
/// 함정도 여기서 흡수한다 — 아래 HiDPI 좌표가 그 예다.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  Capability,
  FileDropEvent,
  OpenDialogOptions,
  Platform,
  SaveDialogOptions,
  SystemTheme,
  Unlisten,
} from "./types.js";

/** Tauri 셸은 일곱 가지를 전부 한다. 목록을 명시적으로 두는 이유는 `has()` 가 추측이 아니라 사실이어야 하기 때문이다. */
const SUPPORTED: ReadonlySet<Capability> = new Set<Capability>([
  "rpc",
  "events",
  "dialog.open",
  "dialog.save",
  "theme",
  "files.drop",
  "window.close",
]);

/// Tauri 가 주는 드롭 좌표는 **물리 픽셀**인데 `elementFromPoint` 는 CSS 픽셀로 동작한다. 나누지 않으면
/// HiDPI 화면에서 드롭 지점이 두 배로 어긋난다. 호출자가 이 함정을 알아야 한다면 그건 계약이 아니므로
/// 여기서 흡수한다.
function toCssPx(value: number): number {
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  return value / dpr;
}

export const tauriPlatform: Platform = {
  name: "tauri",

  has(capability) {
    return SUPPORTED.has(capability);
  },

  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(command, args);
  },

  async listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
    // Tauri 는 `{ payload, event, id }` 를 주지만 호출자가 쓰는 건 payload 뿐이다 — 계약을 좁힌다.
    return await tauriListen<T>(event, (e) => handler(e.payload));
  },

  async pickFile(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
    return await openDialog({
      title: options.title,
      multiple: options.multiple,
      filters: options.filters,
    });
  },

  async pickSavePath(options: SaveDialogOptions = {}): Promise<string | null> {
    return await saveDialog({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
  },

  async systemTheme(): Promise<SystemTheme | null> {
    // 창 테마를 못 읽는 상황(플러그인 미탑재 등)에서 라이트/다크를 찍지 않는다 — 모르면 모른다고 한다.
    try {
      const theme = await getCurrentWindow().theme();
      return theme === "dark" || theme === "light" ? theme : null;
    } catch {
      return null;
    }
  },

  async onThemeChanged(handler: (theme: SystemTheme) => void): Promise<Unlisten> {
    return await getCurrentWindow().onThemeChanged(({ payload }) => {
      if (payload === "dark" || payload === "light") handler(payload);
    });
  },

  async onFileDrop(handler: (event: FileDropEvent) => void): Promise<Unlisten> {
    return await getCurrentWebviewWindow().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "leave") {
        handler({ type: "leave" });
        return;
      }
      const x = toCssPx(p.position.x);
      const y = toCssPx(p.position.y);
      if (p.type === "over") {
        handler({ type: "over", x, y });
        return;
      }
      // 'enter' 와 'drop' 은 경로를 싣고 온다.
      handler({ type: p.type, paths: p.paths, x, y });
    });
  },

  async closeWindow(): Promise<void> {
    await getCurrentWebviewWindow().close();
  },
};
