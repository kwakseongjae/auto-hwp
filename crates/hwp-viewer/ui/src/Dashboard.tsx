/// 대시보드 — 앱의 첫 화면 (이슈 261).
///
/// 이 앱은 "파일 열기 대화상자"에서 시작하지 않는다. 문서는 열었다 닫는 것이 아니라 **지속되는
/// 대상**이고, 첫 화면은 그 목록이다. 전부 로컬이다 — 계정도 클라우드도 없다.
///
/// ## 여기서 일부러 하지 않는 것
///
/// **썸네일을 만들지 않는다.** 미리보기를 그리려면 문서를 열어 조판해야 하는데, 목록에 있는 모든
/// 문서를 그렇게 열면 앱을 켜는 비용이 문서 수에 비례한다. 회색 네모를 대신 넣는 것도 하지 않았다 —
/// 없는 정보를 있는 것처럼 보이게 하는 자리이기 때문이다. 대신 형식과 이름으로 구분한다.
///
/// **경로를 크게 쓰지 않는다.** `~/Desktop/...` 같은 문자열은 어깨너머로도 읽히고 스크린샷에도 남는다.
/// 파일명만 보여 주고 전체 경로는 툴팁에 둔다(#142 의 로컬 전용 규율).
import { useCallback, useEffect, useState } from "react";
import { api, type RecentDocument } from "./api";

/// "3분 전" 식 표기. 절대 시각은 툴팁에 둔다 — 목록에서 중요한 건 "얼마나 최근인가" 이지 몇 시인지가
/// 아니다.
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "방금";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(ms).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function kind(path: string): { label: string; tone: string } {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "hwpx"
    ? { label: "HWPX", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" }
    : { label: "HWP", tone: "bg-sky-500/15 text-sky-700 dark:text-sky-400" };
}

export function Dashboard({ onOpenDialog }: { onOpenDialog: () => void }) {
  const [entries, setEntries] = useState<RecentDocument[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const listing = await api.recentDocuments();
      setEntries(listing.entries);
      setWarnings(listing.warnings);
    } catch {
      // 목록을 못 읽는 것은 치명적이지 않다 — 빈 목록으로 두고 열기 경로는 살려 둔다.
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(
    async (index: number) => {
      setBusy(index);
      try {
        // 경로가 웹뷰를 건너오지 않는다 — Rust 가 검증해 열기 큐에 넣는다.
        await api.reopenRecent(index);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const remove = useCallback(async (index: number) => {
    const listing = await api.removeRecent(index);
    setEntries(listing.entries);
    setWarnings(listing.warnings);
  }, []);

  const empty = entries != null && entries.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-12">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">한칸</h1>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              한글 문서를 열고, 고치고, 되돌린다. 전부 이 기기 안에서.
            </p>
          </div>
          <button
            onClick={onOpenDialog}
            className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            문서 열기 <kbd className="ml-1 opacity-70">⌘O</kbd>
          </button>
        </header>

        {entries == null ? (
          <div className="py-16 text-center text-sm text-neutral-400">불러오는 중…</div>
        ) : empty ? (
          <div className="rounded-xl border border-dashed border-black/10 py-16 text-center dark:border-white/10">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">아직 연 문서가 없습니다.</p>
            <p className="mt-1 text-xs text-neutral-400">
              문서를 열면 여기 쌓이고, 버전을 저장해 되돌아올 수 있습니다.
            </p>
            <button
              onClick={onOpenDialog}
              className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              📂 첫 문서 열기
            </button>
            <p className="mt-4 text-xs text-neutral-400">
              또는 <kbd className="rounded bg-black/5 px-1 dark:bg-white/10">⌘K</kbd> 로 모든 명령
            </p>
          </div>
        ) : (
          <>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">최근 문서</h2>
            <ul className="grid gap-2">
              {entries.map((entry, index) => {
                const k = kind(entry.path);
                return (
                  <li key={`${entry.path}-${entry.lastOpenedMs}`}>
                    <div className="group flex items-center gap-3 rounded-xl border border-black/10 bg-white/60 px-4 py-3 transition-colors hover:border-accent/40 dark:border-white/10 dark:bg-white/[0.03]">
                      <button
                        onClick={() => void open(index)}
                        disabled={busy === index}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"
                        title={entry.path}
                      >
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${k.tone}`}>
                          {k.label}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{basename(entry.path)}</span>
                          <span
                            className="block text-xs text-neutral-400"
                            title={new Date(entry.lastOpenedMs).toLocaleString("ko-KR")}
                          >
                            {busy === index ? "여는 중…" : ago(entry.lastOpenedMs)}
                          </span>
                        </span>
                      </button>
                      <button
                        onClick={() => void remove(index)}
                        className="shrink-0 rounded px-2 py-1 text-xs text-neutral-400 opacity-0 transition-opacity hover:bg-black/5 hover:text-neutral-700 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-neutral-200"
                        title="목록에서 제거 (파일은 그대로)"
                      >
                        제거
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {/* 사라진 파일 등은 조용히 숨기지 않고 말한다 — 목록이 거짓말하면 신뢰를 잃는다. */}
            {warnings.length > 0 && (
              <ul className="mt-3 space-y-1">
                {warnings.map((w) => (
                  <li key={w} className="text-xs text-amber-600 dark:text-amber-400">
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-6 text-xs text-neutral-400">
              목록에서 제거해도 파일은 지워지지 않습니다. 경로는 이 기기에만 저장됩니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
