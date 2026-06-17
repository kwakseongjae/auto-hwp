import { Dialog } from "@kobalte/core/dialog";
import { createEffect, createMemo, For, Show, createSignal } from "solid-js";
import { matchCommand, type Command } from "./commands";

/// The ⌘K command palette — the Raycast spine. A Kobalte Dialog (focus-trap, portal, Esc) wrapping
/// a filtered, keyboard-navigable command list. Every row runs a typed Intent.
export function Palette(props: { open: boolean; onOpenChange: (o: boolean) => void; commands: Command[] }) {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const flat = createMemo(() => props.commands.filter((c) => !c.disabled && matchCommand(c, q())));
  const groups = createMemo(() => {
    const g = new Map<string, Command[]>();
    for (const c of flat()) {
      if (!g.has(c.group)) g.set(c.group, []);
      g.get(c.group)!.push(c);
    }
    return [...g.entries()];
  });

  // Reset query + focus on open; keep selection in range as the list filters.
  createEffect(() => {
    if (props.open) {
      setQ("");
      setSel(0);
      queueMicrotask(() => inputRef?.focus());
    }
  });
  createEffect(() => {
    q();
    setSel(0);
  });

  function run(c: Command) {
    props.onOpenChange(false);
    void c.run();
  }
  function onKey(e: KeyboardEvent) {
    const n = flat().length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (n ? (s + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (n ? (s - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = flat()[sel()];
      if (c) run(c);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <div class="fixed inset-0 z-40 flex items-start justify-center pt-[12vh]">
          <Dialog.Content
            onOpenAutoFocus={(e) => e.preventDefault()}
            class="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-black/10 bg-white/90 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/90"
          >
            <input
              ref={inputRef}
              value={q()}
              onInput={(e) => setQ(e.currentTarget.value)}
              onKeyDown={onKey}
              placeholder="명령 검색…  (열기 · 표 추가 · 내보내기)"
              class="w-full border-b border-black/10 bg-transparent px-4 py-3 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:border-white/10 dark:text-neutral-100"
            />
            <div class="max-h-80 overflow-auto py-1">
              <Show when={flat().length > 0} fallback={<div class="px-4 py-6 text-center text-sm text-neutral-400">결과 없음</div>}>
                <For each={groups()}>
                  {([group, cmds]) => (
                    <div>
                      <div class="px-4 pb-1 pt-2 text-xs font-medium text-neutral-400">{group}</div>
                      <For each={cmds}>
                        {(c) => {
                          const active = () => flat()[sel()]?.id === c.id;
                          return (
                            <button
                              onClick={() => run(c)}
                              onMouseMove={() => setSel(flat().findIndex((x) => x.id === c.id))}
                              class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm"
                              classList={{ "bg-accent/10": active() }}
                            >
                              <span classList={{ "text-ai": c.tone === "ai", "text-neutral-800 dark:text-neutral-100": c.tone !== "ai" }}>
                                {c.title}
                              </span>
                              <span class="flex-1" />
                              <Show when={c.keys}>
                                <kbd class="rounded bg-black/5 px-1.5 py-0.5 text-xs text-neutral-400 dark:bg-white/10">{c.keys}</kbd>
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
