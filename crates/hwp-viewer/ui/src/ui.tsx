/// Shared shell primitives — the toolbar `Tool`/`Sep` and the repeated "pill group + white-bg active"
/// segmented controls (view-mode toggle, zoom) were inlined in App.tsx; extracting them keeps the
/// markup honest and the radius/spacing/border literals consistent. These are PURELY presentational:
/// every gesture still emits the same handler the caller passes — no behavior lives here.

/** A toolbar text button: label, optional icon, shortcut kbd, and an "ai" generative tone.
 *  The main bar passes no icon — emoji glyphs do not belong on that row. */
export function Button(p: {
  onClick: () => void;
  icon?: string;
  label: string;
  keys?: string;
  tone?: "ai";
  disabled?: boolean;
  active?: boolean;
}) {
  const toneClass = p.active
    ? p.tone === "ai"
      ? "bg-ai/10 text-ai"
      : "bg-accent/10 text-accent"
    : p.tone === "ai"
      ? "text-ai"
      : "text-neutral-700 dark:text-neutral-200";
  return (
    <button
      onClick={p.onClick}
      disabled={p.disabled}
      title={p.keys ? `${p.label} (${p.keys})` : p.label}
      className={`flex shrink-0 items-center gap-1.5 rounded-token px-2 py-1 text-sm hover:bg-neutral-200/70 disabled:opacity-35 dark:hover:bg-neutral-700/60 ${toneClass}`}
    >
      {p.icon ? <span className="text-xs opacity-80">{p.icon}</span> : null}
      <span>{p.label}</span>
      {p.keys && (
        <kbd className="ml-0.5 rounded bg-black/5 px-1 text-[10px] text-neutral-400 dark:bg-white/10">{p.keys}</kbd>
      )}
    </button>
  );
}

/** A vertical hairline separator between toolbar groups. */
export function Sep() {
  return <span className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />;
}

/** A segmented control: a rounded track of buttons where exactly one is `active` (lit with a white
 *  raised chip). Drives both the view-surface toggle and the zoom control. `size="sm"` is the tighter
 *  status-bar variant; an item may carry an `icon`, a `title`, and be individually `disabled`. */
export type Segment<T extends string | number> = {
  value: T;
  label: string;
  icon?: string;
  title?: string;
  disabled?: boolean;
};
export function SegmentedControl<T extends string | number>(p: {
  value: T;
  segments: ReadonlyArray<Segment<T>>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  const sm = p.size === "sm";
  return (
    <div className="flex items-center gap-0.5 rounded-token bg-black/5 p-0.5 dark:bg-white/10">
      {p.segments.map((s) => {
        const active = s.value === p.value;
        return (
          <button
            key={String(s.value)}
            onClick={() => p.onChange(s.value)}
            disabled={s.disabled}
            title={s.title}
            className={`flex items-center gap-1 rounded ${
              sm ? "px-1.5 py-0.5 tabular-nums" : "px-2 py-1 text-sm"
            } disabled:opacity-35 ${
              active
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
                : "text-neutral-500 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
            }`}
          >
            {s.icon && <span className="text-xs opacity-80">{s.icon}</span>}
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
