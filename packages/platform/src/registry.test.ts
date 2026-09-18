/// 레지스트리 계약 테스트 (이슈 268).
///
/// 여기서 검증하는 건 "호스트가 정직한가" 다. 능력 신고가 사실과 다르면 UI 는 못 하는 일을 버튼으로
/// 내주고, 사용자는 눌렀는데 아무 일도 안 일어나는 경험을 한다 — #260 의 모양이다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityUnavailable, type Capability, type Platform } from "./types.js";
import {
  hasCapability,
  hasPlatform,
  platform,
  requireCapability,
  setPlatform,
  subscribe,
} from "./registry.js";
import { webPlatform } from "./web.js";

function stub(supported: Capability[]): Platform {
  return {
    name: "stub",
    has: (c) => supported.includes(c),
    invoke: async <T,>() => undefined as T,
    listen: async () => () => {},
    pickFile: async () => null,
    pickSavePath: async () => null,
    systemTheme: async () => null,
    onThemeChanged: async () => () => {},
    onFileDrop: async () => () => {},
    closeWindow: async () => {},
  };
}

afterEach(() => setPlatform(null));

describe("레지스트리", () => {
  it("호스트가 없으면 platform() 은 던진다 — null 을 흘려보내지 않는다", () => {
    expect(hasPlatform()).toBe(false);
    // null 을 돌려주면 확인을 빠뜨린 호출부가 조용히 죽는다. 부팅 순서 버그는 시끄러워야 한다.
    expect(() => platform()).toThrow(/setPlatform/);
  });

  it("호스트가 없어도 hasCapability 는 false 를 준다 — 렌더가 예외로 죽지 않게", () => {
    expect(hasCapability("rpc")).toBe(false);
  });

  it("requireCapability 는 없는 능력을 능력 이름과 함께 거부한다", () => {
    setPlatform(stub(["rpc"]));
    expect(requireCapability("rpc").name).toBe("stub");
    try {
      requireCapability("window.close");
      throw new Error("던졌어야 한다");
    } catch (e) {
      expect(e).toBeInstanceOf(CapabilityUnavailable);
      expect((e as CapabilityUnavailable).capability).toBe("window.close");
      expect((e as CapabilityUnavailable).platform).toBe("stub");
    }
  });

  it("호스트를 갈아 끼우면 구독자에게 알린다", () => {
    const seen = vi.fn();
    const off = subscribe(seen);
    setPlatform(stub([]));
    setPlatform(null);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    setPlatform(stub([]));
    expect(seen).toHaveBeenCalledTimes(2); // 해제 뒤에는 오지 않는다
  });
});

describe("웹 호스트는 못 하는 것을 못 한다고 신고한다", () => {
  // 브라우저는 파일 **경로**를 절대 주지 않는다. 지원한다고 신고하면 계약이 거짓말을 하는 것이다.
  it.each<Capability>(["rpc", "events", "dialog.open", "dialog.save", "files.drop", "window.close"])(
    "%s 는 지원하지 않는다",
    (c) => expect(webPlatform.has(c)).toBe(false),
  );

  it("테마는 진짜로 한다", () => {
    expect(webPlatform.has("theme")).toBe(true);
  });

  it("지원하지 않는 능력을 부르면 CapabilityUnavailable 로 분명히 실패한다", async () => {
    await expect(webPlatform.pickFile()).rejects.toBeInstanceOf(CapabilityUnavailable);
    await expect(webPlatform.closeWindow()).rejects.toBeInstanceOf(CapabilityUnavailable);
  });
});
