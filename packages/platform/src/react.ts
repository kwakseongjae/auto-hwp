/// React 어댑터 (이슈 268) — 별도 진입점.
///
/// 코어(`index.ts`)는 React 를 모른다. `@auto-hwp/editor-core` 가 "Zero React, zero DOM" 인 것과 같은
/// 규율이다 — 계약에 프레임워크가 섞이면 다음 셸이 그 프레임워크를 강제로 물려받는다.
import { useSyncExternalStore } from "react";
import { hasCapability, subscribe } from "./registry.js";
import type { Capability } from "./types.js";

/// 이 호스트가 해당 능력을 제공하는가 — 렌더에서 묻는 방법.
///
/// ```tsx
/// const canClose = useCapability("window.close");
/// {canClose && <button onClick={…}>닫기</button>}
/// ```
///
/// 버튼을 띄워 놓고 눌렀을 때 실패시키는 대신 **아예 띄우지 않는다**. 웹과 데스크톱이 같은 컴포넌트를
/// 쓰면서도 각자 할 수 있는 것만 보여주게 하는 자리다.
export function useCapability(capability: Capability): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasCapability(capability),
    // SSR: 서버에는 호스트가 없다. `false` 가 정답이다 — 없는 능력을 있다고 그렸다가 하이드레이션에서
    // 사라지는 것보다, 없다고 그렸다가 나타나는 편이 덜 놀랍다.
    () => false,
  );
}
