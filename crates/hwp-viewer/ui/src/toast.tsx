import { createSignal, For, Show } from "solid-js";

export type ToastAction = { label: string; run: () => void };
export type ToastKind = "info" | "ok" | "warn";
type Toast = { id: number; kind: ToastKind; msg: string; actions?: ToastAction[] };

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

/// Show a transient toast. Toasts with actions linger longer so the user can click them.
export function toast(kind: ToastKind, msg: string, actions?: ToastAction[]) {
  const id = nextId++;
  setToasts((t) => [...t, { id, kind, msg, actions }]);
  const dismiss = () => setToasts((t) => t.filter((x) => x.id !== id));
  setTimeout(dismiss, actions && actions.length ? 8000 : 3500);
  return dismiss;
}

/// Fixed bottom-center toast stack. Mount once near the app root.
export function Toaster() {
  const dot = (k: ToastKind) =>
    k === "ok" ? "bg-emerald-500" : k === "warn" ? "bg-amber-500" : "bg-accent";
  return (
    <div class="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2">
      <For each={toasts()}>
        {(t) => (
          <div class="pointer-events-auto flex items-center gap-3 rounded-lg border border-black/10 bg-white/90 px-3 py-2 text-sm shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/90">
            <span class={`h-2 w-2 shrink-0 rounded-full ${dot(t.kind)}`} />
            <span class="text-neutral-800 dark:text-neutral-100">{t.msg}</span>
            <Show when={t.actions}>
              <For each={t.actions}>
                {(a) => (
                  <button
                    onClick={() => {
                      a.run();
                      setToasts((ts) => ts.filter((x) => x.id !== t.id));
                    }}
                    class="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent/10"
                  >
                    {a.label}
                  </button>
                )}
              </For>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
