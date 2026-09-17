/// 버전 기록 패널 (이슈 261).
///
/// ## 이 패널이 지키는 약속
///
/// **되돌리기가 무섭지 않아야 한다.** 되돌리면 Rust 쪽이 *현재 상태를 먼저 버전으로 남기고* 간다
/// ("되돌리기 직전"). 그래서 되돌린 뒤에도 되돌아올 수 있고, 패널은 그 사실을 사람에게 말해 준다 —
/// 안전망이 있다는 걸 모르면 있으나 마나다.
///
/// **고정한 것은 사라지지 않는다.** 자동 정리는 고정되지 않은 것만 건드린다. 사람이 "여기로 돌아올
/// 것" 이라고 표시해 둔 지점이 조용히 없어지는 건 이 기능이 저지를 수 있는 최악이다.
import { useCallback, useEffect, useState } from "react";
import { api, type VersionSummary } from "./api";

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function VersionsPanel({
  canEdit,
  onRestored,
  onClose,
}: {
  canEdit: boolean;
  /** 되돌린 뒤의 쪽수 — 호출자가 페이지 목록을 다시 그린다. */
  onRestored: (pages: number) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.listVersions());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await api.saveVersion(label.trim());
      setLabel("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [label, load]);

  const restore = useCallback(
    async (sequence: number) => {
      setBusy(true);
      try {
        onRestored(await api.restoreVersion(sequence));
        setConfirming(null);
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [load, onRestored],
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-black/10 bg-neutral-50/60 dark:border-white/10 dark:bg-neutral-900/40">
      <header className="flex items-center justify-between gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10">
        <h2 className="text-xs font-semibold">버전 기록</h2>
        <button
          onClick={onClose}
          className="rounded px-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          title="닫기 (⌘⇧V)"
        >
          ✕
        </button>
      </header>

      {canEdit && (
        <div className="border-b border-black/10 p-3 dark:border-white/10">
          <div className="flex gap-1.5">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void save();
              }}
              placeholder="이 지점의 이름 (선택)"
              maxLength={80}
              className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-2 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-accent dark:border-white/10 dark:bg-white/5"
            />
            <button
              onClick={() => void save()}
              disabled={busy}
              className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              저장
            </button>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-400">
            지금 상태를 되돌아올 지점으로 남깁니다. 자동 저장이 아니라, 누를 때만 기록됩니다.
          </p>
        </div>
      )}

      {error && <p className="px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items == null ? (
          <p className="px-3 py-3 text-xs text-neutral-400">불러오는 중…</p>
        ) : items.length === 0 ? (
          <p className="px-3 py-3 text-xs leading-relaxed text-neutral-400">
            아직 저장한 버전이 없습니다.
            <br />
            크게 고치기 전에 한 번 남겨 두면 언제든 돌아올 수 있습니다.
          </p>
        ) : (
          <ul className="divide-y divide-black/5 dark:divide-white/5">
            {items.map((v) => (
              <li key={v.sequence} className="px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {v.label || <span className="font-normal text-neutral-400">이름 없음</span>}
                  </span>
                  <button
                    onClick={() => void api.pinVersion(v.sequence, !v.pinned).then(load)}
                    className={`shrink-0 rounded px-1 text-xs ${v.pinned ? "text-amber-500" : "text-neutral-300 hover:text-neutral-500"}`}
                    title={v.pinned ? "고정 해제" : "고정 — 자동 정리에서 지켜진다"}
                  >
                    ★
                  </button>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-400 tabular-nums">
                  <span title={new Date(v.savedAtMs).toLocaleString("ko-KR")}>{when(v.savedAtMs)}</span>
                  {v.pages > 0 && <span>· {v.pages}쪽</span>}
                  <span>· {kb(v.byteLen)}</span>
                </div>

                {confirming === v.sequence ? (
                  <div className="mt-1.5 rounded-md bg-amber-500/10 p-2">
                    <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                      이 버전으로 되돌립니다. <b>지금 상태는 「되돌리기 직전」으로 먼저 저장</b>되니
                      다시 돌아올 수 있습니다.
                    </p>
                    <div className="mt-1.5 flex gap-1.5">
                      <button
                        onClick={() => void restore(v.sequence)}
                        disabled={busy}
                        className="rounded bg-amber-600 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                      >
                        되돌리기
                      </button>
                      <button
                        onClick={() => setConfirming(null)}
                        className="rounded px-2 py-1 text-[11px] text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 flex gap-2 text-[11px]">
                    <button
                      onClick={() => setConfirming(v.sequence)}
                      disabled={!canEdit}
                      className="text-accent hover:underline disabled:text-neutral-300"
                    >
                      되돌리기
                    </button>
                    <button
                      onClick={() => void api.deleteVersion(v.sequence).then(load)}
                      className="text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400"
                    >
                      삭제
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="border-t border-black/5 px-3 py-2 text-[10px] leading-relaxed text-neutral-400 dark:border-white/5">
        버전은 이 기기에만 저장됩니다. ★ 고정한 것은 자동 정리에서 지켜집니다.
      </p>
    </aside>
  );
}
