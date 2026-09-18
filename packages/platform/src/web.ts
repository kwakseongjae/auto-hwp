/// 브라우저 호스트 구현 (이슈 268).
///
/// ## 이 파일의 요점은 "거의 다 못 한다"를 정직하게 적는 것이다
///
/// 브라우저는 파일 **경로**를 주지 않는다 — `<input type=file>` 도 드래그&드롭도 `File` 객체를 줄 뿐,
/// `/Users/…/문서.hwpx` 같은 경로는 보안상 절대 노출되지 않는다. 그래서 `dialog.open` 과 `files.drop` 은
/// 계약이 정의한 의미(경로를 돌려준다)로는 **지원 불가**다.
///
/// 이걸 "대충 되는 척" 하고 `File` 을 경로 자리에 끼워 넣을 수도 있었다. 하지 않았다. 웹에서 파일을
/// 받는 일은 바이트를 wasm 으로 넘기는 **다른 계약**이고(`@auto-hwp/engine`), 그건 이 인터페이스가
/// 흉내 낼 대상이 아니라 별개의 경로다. 여기서 거짓으로 신고하면 UI 는 데스크톱 전용 버튼을 웹에도
/// 띄우고, 눌렀을 때 조용히 아무 일도 일어나지 않는다 — 정확히 #260 이 그런 종류의 실패였다.
///
/// 실제로 웹이 할 수 있는 것은 **OS 테마 하나**다. 그건 진짜로 한다.
import { CapabilityUnavailable, type Capability, type Platform, type SystemTheme, type Unlisten } from "./types.js";

const SUPPORTED: ReadonlySet<Capability> = new Set<Capability>(["theme"]);

/// 미지원 능력은 **거부(reject)** 한다 — 동기 throw 가 아니다.
///
/// 계약이 `Promise` 를 돌려준다고 했으면 실패도 거부로 와야 한다. 동기로 던지면
/// `pickFile().catch(…)` 가 못 잡고 호출부가 통째로 터진다. 인터페이스가 약속한 모양을 실패 경로에서도
/// 지키는 것이 계약이다.
function unavailable<T>(capability: Capability): Promise<T> {
  return Promise.reject(new CapabilityUnavailable(capability, "web"));
}

function prefersDark(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

export const webPlatform: Platform = {
  name: "web",

  has(capability) {
    return SUPPORTED.has(capability);
  },

  invoke() {
    // 웹 셸은 네이티브가 없다 — 엔진은 `EngineAdapter`(WasmAdapter)로 간다. RPC 는 그 경로가 아니다.
    return unavailable("rpc");
  },

  listen() {
    return unavailable("events");
  },

  pickFile() {
    return unavailable("dialog.open");
  },

  pickSavePath() {
    return unavailable("dialog.save");
  },

  async systemTheme(): Promise<SystemTheme | null> {
    const mq = prefersDark();
    return mq == null ? null : mq.matches ? "dark" : "light";
  },

  async onThemeChanged(handler: (theme: SystemTheme) => void): Promise<Unlisten> {
    const mq = prefersDark();
    if (mq == null) return () => {};
    const onChange = (e: MediaQueryListEvent) => handler(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  },

  onFileDrop() {
    return unavailable("files.drop");
  },

  closeWindow() {
    // 브라우저는 스크립트가 열지 않은 탭을 닫을 수 없다. `window.close()` 를 불러 봐야 조용히 무시된다.
    return unavailable("window.close");
  },
};
