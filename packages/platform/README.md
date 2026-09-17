# @auto-hwp/platform

auto-hwp 셸들이 **호스트 능력**(RPC · 이벤트 · 파일 다이얼로그 · OS 테마 · 파일 드롭 · 창)을 보는 하나의 계약.

> **`src/tauri.ts` 바깥에서 `@tauri-apps/*` 를 import 하는 곳은 0건이다. 그게 이 패키지의 존재 이유 전부다.**

이 규칙은 문서가 아니라 테스트가 지킨다 — `src/platform-boundary.test.ts` 가 저장소 소스를 훑어 위반을 실패시키고,
`scripts/verify-local.sh --full` 에서 돈다.

## 왜 필요했나

엔진에 대해서는 이미 제대로 하고 있었다. `EngineAdapter` 34메서드 **하나**를 `WasmAdapter`(웹)와
`TauriAdapter`(데스크톱)가 각각 구현한다. 그런데 **호스트 능력**에는 그 계약이 없어서 셸마다 각자 구현했고,
[#260](https://github.com/kwakseongjae/auto-hwp/issues/260) 이 그 대가였다 — OS 파일 열기 요청 처리가 한쪽
셸에만 붙어서, 파일을 더블클릭해도 문서가 열리지 않았다.

## 쓰는 법

셸 부팅에서 호스트를 한 번 정한다:

```ts
import { setPlatform } from "@auto-hwp/platform";
import { tauriPlatform } from "@auto-hwp/platform/tauri";

setPlatform(tauriPlatform);
```

그 뒤로는 어디서든:

```ts
import { platform } from "@auto-hwp/platform";

const pages = await platform().invoke<number>("page_count");
const path = await platform().pickFile({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
```

## 능력은 정직하게 신고한다

브라우저는 파일 **경로**를 주지 않는다 — `<input type=file>` 도 드래그&드롭도 `File` 객체를 줄 뿐이다.
그래서 `webPlatform` 은 `dialog.open` 과 `files.drop` 을 **지원하지 않는다고 신고한다**. 지원하는 척하고
조용히 실패하는 대신, UI 가 물어보고 그 경로를 아예 보여주지 않게 한다:

```tsx
import { useCapability } from "@auto-hwp/platform/react";

const canClose = useCapability("window.close");
{canClose && <button onClick={() => platform().closeWindow()}>닫기</button>}
```

| 능력 | `tauri` | `web` |
|---|:--:|:--:|
| `rpc` · `events` | ✅ | ❌ (엔진은 `EngineAdapter`/wasm 경로) |
| `dialog.open` · `dialog.save` | ✅ | ❌ (브라우저는 경로를 주지 않는다) |
| `files.drop` | ✅ | ❌ (〃) |
| `window.close` | ✅ | ❌ |
| `theme` | ✅ | ✅ |

## 계약은 Tauri 를 미러링하지 않는다

`getCurrentWebviewWindow().onDragDropEvent()` 를 그대로 재수출하면 결합을 **옮기기만** 한다.
타입은 전부 우리 의미이고, 호스트 고유의 함정은 어댑터가 흡수한다 — 예를 들어 Tauri 가 드롭 좌표를
물리 픽셀로 주는 HiDPI 문제는 `tauri.ts` 안에서 CSS 픽셀로 바뀌어 나온다. 호출자가 그 함정을 알아야
한다면 그건 계약이 아니다.
