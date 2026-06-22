import { useEffect, useMemo, useRef, useState } from "react";
import { matchCommand, type Command } from "./commands";
import { Modal } from "./Modal";

/// The ⌘K command palette — the Raycast spine. A filtered, keyboard-navigable command list in a
/// Modal (overlay + Esc). Every row runs a typed Intent.
export function Palette(props: { open: boolean; onOpenChange: (o: boolean) => void; commands: Command[] }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(
    () => props.commands.filter((c) => !c.disabled && matchCommand(c, q)),
    [props.commands, q],
  );
  const groups = useMemo(() => {
    const g = new Map<string, Command[]>();
    for (const c of flat) {
      if (!g.has(c.group)) g.set(c.group, []);
      g.get(c.group)!.push(c);
    }
    return [...g.entries()];
  }, [flat]);

  // Reset query + focus on open.
  useEffect(() => {
    if (props.open) {
      setQ("");
      setSel(0);
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [props.open]);
  // Keep selection in range as the list filters.
  useEffect(() => {
    setSel(0);
  }, [q]);

  function run(c: Command) {
    props.onOpenChange(false);
    void c.run();
  }
  function onKey(e: React.KeyboardEvent) {
    const n = flat.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (n ? (s + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (n ? (s - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = flat[sel];
      if (c) run(c);
    }
  }

  return (
    <Modal open={props.open} onClose={() => props.onOpenChange(false)} topClass="top-[12vh]">
      <div className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-black/10 bg-white/90 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/90">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={onKey}
          placeholder="명령 검색…  (열기 · 표 추가 · 내보내기)"
          className="w-full border-b border-black/10 bg-transparent px-4 py-3 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:border-white/10 dark:text-neutral-100"
        />
        <div className="max-h-80 overflow-auto py-1">
          {flat.length > 0 ? (
            groups.map(([group, cmds]) => (
              <div key={group}>
                <div className="px-4 pb-1 pt-2 text-xs font-medium text-neutral-400">{group}</div>
                {cmds.map((c) => {
                  const active = flat[sel]?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => run(c)}
                      onMouseMove={() => setSel(flat.findIndex((x) => x.id === c.id))}
                      className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${active ? "bg-accent/10" : ""}`}
                    >
                      <span className={c.tone === "ai" ? "text-ai" : "text-neutral-800 dark:text-neutral-100"}>
                        {c.title}
                      </span>
                      <span className="flex-1" />
                      {c.keys && (
                        <kbd className="rounded bg-black/5 px-1.5 py-0.5 text-xs text-neutral-400 dark:bg-white/10">{c.keys}</kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="px-4 py-6 text-center text-sm text-neutral-400">결과 없음</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
