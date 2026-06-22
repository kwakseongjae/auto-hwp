import { useSyncExternalStore } from "react";

export type ToastAction = { label: string; run: () => void };
export type ToastKind = "info" | "ok" | "warn";
type Toast = { id: number; kind: ToastKind; msg: string; actions?: ToastAction[] };

// A tiny module-level external store so `toast()` is callable from anywhere (not just components),
// mirroring the old Solid module-signal. `useSyncExternalStore` subscribes the <Toaster/> to it.
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function snapshot() {
  return toasts;
}

/// Show a transient toast. Toasts with actions linger longer so the user can click them.
export function toast(kind: ToastKind, msg: string, actions?: ToastAction[]) {
  const id = nextId++;
  toasts = [...toasts, { id, kind, msg, actions }];
  emit();
  const dismiss = () => {
    toasts = toasts.filter((x) => x.id !== id);
    emit();
  };
  setTimeout(dismiss, actions && actions.length ? 8000 : 3500);
  return dismiss;
}

function dismissNow(id: number) {
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

/// Fixed bottom-center toast stack. Mount once near the app root.
export function Toaster() {
  const ts = useSyncExternalStore(subscribe, snapshot);
  const dot = (k: ToastKind) =>
    k === "ok" ? "bg-emerald-500" : k === "warn" ? "bg-amber-500" : "bg-accent";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2">
      {ts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 rounded-lg border border-black/10 bg-white/90 px-3 py-2 text-sm shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/90"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot(t.kind)}`} />
          <span className="text-neutral-800 dark:text-neutral-100">{t.msg}</span>
          {t.actions?.map((a, i) => (
            <button
              key={i}
              onClick={() => {
                a.run();
                dismissNow(t.id);
              }}
              className="rounded-md px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent/10"
            >
              {a.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
