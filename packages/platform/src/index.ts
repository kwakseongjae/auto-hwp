/// `@auto-hwp/platform` — 호스트 능력 계약 (이슈 268).
///
/// 여기서 구현체를 재수출하지 **않는다**. `tauri.ts` 를 배럴에 넣으면 웹 번들이 `@tauri-apps/*` 를
/// 끌어오게 되고, 그러면 이 패키지가 막으려는 결합이 정확히 되살아난다. 셸이 자기 호스트를 명시적으로
/// 고른다:
///
/// ```ts
/// import { setPlatform } from "@auto-hwp/platform";
/// import { tauriPlatform } from "@auto-hwp/platform/tauri";
/// setPlatform(tauriPlatform);
/// ```
export type {
  Capability,
  DialogFilter,
  FileDropEvent,
  OpenDialogOptions,
  Platform,
  SaveDialogOptions,
  SystemTheme,
  Unlisten,
} from "./types.js";
export { CapabilityUnavailable } from "./types.js";
export {
  hasCapability,
  hasPlatform,
  platform,
  requireCapability,
  setPlatform,
  subscribe,
} from "./registry.js";
