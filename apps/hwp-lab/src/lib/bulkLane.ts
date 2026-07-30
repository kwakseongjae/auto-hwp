// 벌크 채움(/bulk)의 EngineLane 구현 2종 — 073 2단계.
//  * `WorkerLane`(기본): packages/engine의 모듈 워커(`public/hwp/worker.js` — copy-wasm.mjs가 배치)를
//    EngineWorkerClient로 구동한다. 파싱·채움·직렬화·조판이 전부 워커 스레드에서 돌아 100명 배치에서도
//    메인스레드가 멈추지 않는다. worker.js는 손대지 않았다(화이트리스트 메서드만 쓴다 — SVG 검열은
//    메인스레드의 `sanitizeSvg`가 맡는다: 워커 화이트리스트에 `renderPageSvgSanitized`가 없다).
//  * `MainThreadLane`(탈출구 `?bulkWorker=off`): 기존 메인스레드 경로. 워커 사용 불가 환경의 폴백이자
//    BEFORE/AFTER 실측 스위치다(LabWorkspace의 `?engineWorker=off`와 같은 철학).
//
// **문서 1개 계약**: 두 레인 모두 `open`이 직전 문서를 닫는다(워커 계약과 동일) — wasm 핸들 누수 방지.
import { HwpDoc, initEngine, resetEngine } from "@auto-hwp/engine";
import { EngineWorkerClient } from "@auto-hwp/engine/worker-client";
import type { EngineLane } from "./bulkEngine";

export interface BulkLane extends EngineLane {
  /** wasm 인스턴스 준비(멱등). */
  ready(): Promise<void>;
  /** 오염(wasm 트랩/워커 사망) 복구 — 다음 행부터 다시 살아난다. */
  reset(): Promise<void>;
  /** 열린 문서만 회수(레인은 유지). */
  release(): void;
  /** 레인 자체 종료(페이지 이탈). 진행 중 호출은 `worker_terminated`로 거절된다. */
  dispose(): void;
  readonly kind: "worker" | "main";
}

export class WorkerLane implements BulkLane {
  readonly kind = "worker" as const;
  #client: EngineWorkerClient;
  #wasm: URL;

  constructor(workerUrl: URL, wasmUrl: URL) {
    this.#client = new EngineWorkerClient({ url: workerUrl });
    this.#wasm = wasmUrl;
  }

  ready(): Promise<void> {
    return this.#client.init(this.#wasm);
  }

  open(bytes: Uint8Array, name?: string): Promise<{ pages: number }> {
    return this.#client.open(bytes, name);
  }

  call<T = unknown>(method: string, params?: unknown[]): Promise<T> {
    return this.#client.call<T>(method, params);
  }

  reset(): Promise<void> {
    return this.#client.reset(this.#wasm);
  }

  release(): void {
    this.#client.free();
  }

  dispose(): void {
    this.#client.terminate();
  }
}

/** 메인스레드 폴백 — 워커 없이 같은 인터페이스. 이 레인에서는 생성 중 프레임이 그대로 막힌다
 *  (그게 1단계 상태였고, 2단계의 개선을 실측하는 기준선이다). */
export class MainThreadLane implements BulkLane {
  readonly kind = "main" as const;
  #doc: HwpDoc | null = null;
  #wasm: URL;
  #inited = false;

  constructor(wasmUrl: URL) {
    this.#wasm = wasmUrl;
  }

  async ready(): Promise<void> {
    if (this.#inited) return;
    await initEngine(this.#wasm);
    this.#inited = true;
  }

  async open(bytes: Uint8Array, name?: string): Promise<{ pages: number }> {
    // 파싱 성공한 뒤에만 직전 문서를 닫는다(워커의 "실패한 open은 이전 문서 생존" 계약과 동일).
    const next = HwpDoc.open(bytes, name);
    this.release();
    this.#doc = next;
    return { pages: next.pageCount() };
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.#doc) throw Object.assign(new Error("no document open"), { code: "no_document" });
    const fn = (this.#doc as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method];
    if (typeof fn !== "function") throw new Error(`unknown engine method: ${method}`);
    return fn.apply(this.#doc, params) as T;
  }

  async reset(): Promise<void> {
    this.#doc = null; // 트랩으로 오염된 인스턴스의 핸들은 이미 죽었다(free 하면 안 된다)
    await resetEngine(this.#wasm); // initEngine 은 성공 promise 를 캐시한다 — 재인스턴스화는 이쪽
    this.#inited = true;
  }

  release(): void {
    if (!this.#doc) return;
    try {
      this.#doc.free();
    } catch {
      /* 이미 회수됨(트랩 세대 증가) */
    }
    this.#doc = null;
  }

  dispose(): void {
    this.release();
  }
}

/** 직렬화 락 — 레인은 문서 1개 계약이라 생성/프리뷰가 겹치면 서로의 문서를 닫는다. 모든 레인 사용은
 *  이 락을 통과한다(호출 순서 = 완료 순서). */
export function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** 프레임 양보 — 폴백(메인스레드) 레인에서 진행률이 실제로 다시 그려지게 한다. setTimeout은 백그라운드
 *  탭에서 1초 클램프가 걸려 배치를 세우므로 MessageChannel 매크로태스크를 쓴다(React 스케줄러와 같은
 *  이유). 워커 레인에서도 비용이 없어 항상 건다. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "undefined") {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}
