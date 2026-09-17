/// 검수 패널 (이슈 259) — 이 앱의 논지.
///
/// 우리 계측기(`layout-check`, 82건 오라클 스윕)는 전부 CLI 안에만 있었다. "원본과 쪽수가 같은가",
/// "줄이 몇 % 더 나오는가" 를 사람이 보려면 터미널을 켜야 했다. 그 숫자를 화면에 올리면 한 화면이
/// 두 가지 일을 한다 — 사용자에게는 **「원본과 같은가」의 답**, 우리에게는 **회귀를 눈으로 잡는 하니스**.
///
/// ## 이 패널이 지키는 규율
///
/// 1. **숫자를 꾸미지 않는다.** 저장 lineseg 가 없는 문서는 0% 가 아니라 **채점 불가**다. 근거를 댈 수
///    없으면 왜 없는지 말한다(068 규율).
/// 2. **CLI 와 같은 숫자.** 계산은 Rust 쪽 `fidelity_report` 가 `hwp_core::layout_fidelity` 로 하며,
///    분모까지 `layout-check` 와 맞췄다. 앱이 자체 계산을 하면 계측기가 둘이 되고 둘 다 못 믿게 된다.
/// 3. **참값이라고 말하지 않는다.** 이 점수는 한/글의 살아있는 렌더러가 아니라 파일에 저장된
///    레이아웃 캐시 기준이다(#72). 배지에 그렇게 적는다.
import { useCallback, useEffect, useState } from "react";
import { api, type Fidelity } from "./api";

type Tone = "good" | "warn" | "bad" | "muted";

const TONE: Record<Tone, string> = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  bad: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  muted: "bg-neutral-500/10 text-neutral-500",
};

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${TONE[tone]}`}>
      {children}
    </span>
  );
}

/// 한 줄 지표. `detail` 은 숫자 뒤에 붙는 작은 근거("90/91 문단" 같은 것) — 퍼센트만 보여 주면
/// 분모를 숨기는 셈이라, 표본이 작을 때 사람이 과신한다.
function Row({
  label,
  value,
  detail,
  tone = "muted",
  title,
}: {
  label: string;
  value: React.ReactNode;
  detail?: string;
  tone?: Tone;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1" title={title}>
      <span className="shrink-0 text-xs text-neutral-500">{label}</span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        {detail && <span className="truncate text-[11px] text-neutral-400 tabular-nums">{detail}</span>}
        <Badge tone={tone}>{value}</Badge>
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-black/5 px-3 py-2 last:border-0 dark:border-white/5">
      <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</h3>
      {children}
    </section>
  );
}

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);

/// 줄 정확도의 색: 98.9% 는 게이트 바닥이다(`canonical-layout-gate`). 그 아래로 떨어지면 CI 가 막는
/// 값이므로 빨강이고, 95% 위는 노랑, 그 아래는 빨강으로 둔다.
function lineTone(p: number | null): Tone {
  if (p == null) return "muted";
  if (p >= 98.9) return "good";
  if (p >= 95) return "warn";
  return "bad";
}

/// 충실도를 재고 들고 있는 훅. **패널이 아니라 App 이 이걸 쓴다** — 배지가 타이틀바에 상주하려면
/// 패널을 한 번도 열지 않아도 수치가 있어야 하기 때문이다. 패널을 열어야 배지가 뜨면 "항상 보인다"가
/// 거짓말이 된다.
export function useFidelity(revision: number) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Fidelity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.fidelityReport());
    } catch (e) {
      setError(String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 문서가 바뀌거나 편집으로 리비전이 오르면 다시 잰다. 조판 전체를 다시 도는 일이라 타자마다
  // 부르지는 않는다 — revision 단위가 상한이다.
  useEffect(() => {
    if (revision > 0) void reload();
  }, [revision, reload]);

  return { data, loading, error, reload, summary: data ? summarize(data) : null };
}

export function InspectPanel({
  data,
  loading,
  error,
  onRefresh,
}: {
  data: Fidelity | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-black/10 bg-neutral-50/60 dark:border-white/10 dark:bg-neutral-900/40">
      <header className="flex items-center justify-between gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10">
        <h2 className="text-xs font-semibold">검수</h2>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
          title="다시 재기"
        >
          {loading ? "재는 중…" : "↻"}
        </button>
      </header>

      {error && (
        <p className="px-3 py-3 text-xs text-rose-600 dark:text-rose-400">검수를 부르지 못했다: {error}</p>
      )}

      {!error && data && !data.available && (
        <p className="px-3 py-3 text-xs leading-relaxed text-neutral-500">
          {data.reason}
          <br />
          <span className="text-neutral-400">점수를 꾸미지 않는다 — 근거가 없으면 없다고 말한다.</span>
        </p>
      )}

      {!error && data?.available && (
        <>
          <Section title="쪽수">
            <Row
              label="우리 · 한컴"
              value={`${data.pages.ours} · ${data.pages.oracle}`}
              tone={data.pages.match ? "good" : "bad"}
              detail={data.pages.match ? "일치" : `${data.pages.ours > data.pages.oracle ? "+" : ""}${data.pages.ours - data.pages.oracle}`}
              title="우리 조판이 만든 쪽수 vs 한컴이 파일에 저장해 둔 쪽수"
            />
          </Section>

          <Section title="본문 줄">
            {data.body.scorable ? (
              <>
                <Row
                  label="정확 일치"
                  value={pct(data.body.exact_pct)}
                  detail={`${data.body.exact}/${data.body.paragraphs}`}
                  tone={lineTone(data.body.exact_pct)}
                  title="게이트 바닥은 98.9% 다"
                />
                <Row
                  label="총 줄수"
                  value={`${data.body.our_lines} · ${data.body.oracle_lines}`}
                  tone={data.body.our_lines === data.body.oracle_lines ? "good" : "warn"}
                  detail="우리 · 한컴"
                />
              </>
            ) : (
              <p className="py-1 text-[11px] leading-relaxed text-neutral-400">
                저장 lineseg 없음 — <b>채점 불가</b>(0점 아님).
                <br />
                변환·정규화된 HWPX 가 흔히 그렇다.
              </p>
            )}
          </Section>

          <Section title="표 셀 줄">
            {data.cells.scorable ? (
              <>
                <Row
                  label="정확 일치"
                  value={pct(data.cells.exact_pct)}
                  detail={`${data.cells.exact}/${data.cells.compared}`}
                  tone={lineTone(data.cells.exact_pct)}
                />
                <Row
                  label="총 줄수"
                  value={`${data.cells.our_lines} · ${data.cells.oracle_lines}`}
                  tone={data.cells.our_lines === data.cells.oracle_lines ? "good" : "warn"}
                  detail="우리 · 한컴"
                />
                {data.cells.structure_mismatches > 0 && (
                  <Row
                    label="구조 불일치"
                    value={data.cells.structure_mismatches}
                    tone="bad"
                    title="셀 트리가 어긋난 지점 — 줄수 비교가 무의미해지는 신호"
                  />
                )}
              </>
            ) : (
              <p className="py-1 text-[11px] text-neutral-400">셀 oracle 없음 — 채점 불가.</p>
            )}
          </Section>

          <Section title="조판 구성">
            <Row label="표" value={data.blocks.tables} detail={`행 ${data.blocks.table_rows}`} />
            <Row label="이미지" value={data.blocks.images} />
            <Row label="수식" value={data.blocks.equations} />
            <Row
              label="본문 높이"
              value={`${(data.blocks.body_height / 7200 * 25.4).toFixed(0)}mm`}
              detail={`${data.blocks.body_height} HU`}
              title="쪽당 본문 상자 높이 (첫 구역)"
            />
          </Section>

          <p className="px-3 py-2 text-[10px] leading-relaxed text-neutral-400">{data.basis}</p>
        </>
      )}
    </aside>
  );
}

/// 타이틀바 배지가 쓰는 한 줄 요약 — 패널을 닫아 둬도 충실도는 **항상 보여야** 한다.
export type InspectSummary = { pagesMatch: boolean; ours: number; oracle: number; scorable: boolean };

function summarize(f: Fidelity): InspectSummary | null {
  if (!f.available) return null;
  return {
    pagesMatch: f.pages.match,
    ours: f.pages.ours,
    oracle: f.pages.oracle,
    scorable: f.scorable,
  };
}
