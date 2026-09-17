/// 어떤 호스트 위에서 돌고 있는지 한 곳에서 안다 (이슈 268).
///
/// 셸이 부팅할 때 `setPlatform()` 을 한 번 부르고, 그 뒤로는 모두 `platform()` 으로 꺼내 쓴다.
/// 모듈 최상위에서 `import { invoke } from "@tauri-apps/api/core"` 하던 것을 대체하는 자리다.
///
/// ## 왜 전역인가
///
/// 호스트는 프로세스당 하나다. 이걸 React 컨텍스트로 내리면 컴포넌트 밖(`api.ts` 같은 순수 모듈)에서
/// 못 쓰는데, 정작 RPC 를 제일 많이 하는 곳이 거기다. 그래서 전역 레지스트리 하나 — 다만 **테스트가
/// 바꿔 끼울 수 있도록** 교체 가능하게 둔다.
import { CapabilityUnavailable, type Capability, type Platform } from "./types.js";

let current: Platform | null = null;

/** 구독자 — `useCapability` 가 호스트 교체를 따라가게 한다. */
const listeners = new Set<() => void>();

/// 이 프로세스의 호스트를 정한다. 셸 부팅 때 한 번.
///
/// 두 번 부르는 것을 막지 않는다 — 테스트가 교체하고 되돌리는 게 정상 사용이기 때문이다. 대신 바뀌면
/// 구독자에게 알린다.
export function setPlatform(next: Platform | null): void {
  current = next;
  for (const notify of listeners) notify();
}

/// 현재 호스트. 아직 정해지지 않았으면 던진다.
///
/// `null` 을 돌려주고 호출자마다 확인하게 하지 않는다 — 그러면 확인을 빠뜨린 곳이 조용히 죽는다.
/// 호스트가 없는 것은 부팅 순서 버그이지 런타임에 다룰 상태가 아니다.
export function platform(): Platform {
  if (current == null) {
    throw new Error(
      "호스트가 아직 등록되지 않았다 — 셸 부팅에서 setPlatform() 을 먼저 불러야 한다 (이슈 268)",
    );
  }
  return current;
}

/** 등록 여부만 본다 (부팅 경로 진단용). */
export function hasPlatform(): boolean {
  return current != null;
}

/// 현재 호스트가 이 능력을 제공하는가. 호스트가 없으면 `false` — 여기서는 던지지 않는다.
///
/// 이 함수의 용도는 "UI 를 보여줄까?" 이고, 부팅 전 렌더에서 예외를 던지는 것보다 "아직 못 한다"가
/// 정답이기 때문이다.
export function hasCapability(capability: Capability): boolean {
  return current != null && current.has(capability);
}

/// 그 능력이 반드시 있어야 하는 자리에서 쓴다. 없으면 능력 이름을 담아 던진다.
export function requireCapability(capability: Capability): Platform {
  const host = platform();
  if (!host.has(capability)) throw new CapabilityUnavailable(capability, host.name);
  return host;
}

/** 호스트 교체 구독 (React 어댑터가 쓴다). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
