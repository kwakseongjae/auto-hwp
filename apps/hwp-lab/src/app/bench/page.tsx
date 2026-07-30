import styles from "./bench.module.css";
import { ThemeToggle } from "@/components/ThemeToggle";

// ⚠️ 이 페이지는 **서버 컴포넌트 · 정적 콘텐츠**다. "use client" 를 붙이지 마라 —
// 크롤러/공유 스크래퍼가 JS 없이 수치를 읽을 수 있어야 하는 것이 이 페이지의 존재 이유다.
// 랜딩(LabWorkspace)과 달리 wasm 도, 상태도, 이벤트 핸들러도 필요 없다.
//
// 수치 규율(정본: docs/BENCHMARK.md):
//   여기 적힌 모든 숫자는 레포에서 **실제로 실행해 얻은 출력**이거나 테스트에 baseline 으로
//   박혀 있는 값이다. 추정치·반올림한 인상치는 싣지 않는다. 갱신할 때는 아래 재현 커맨드를
//   다시 돌려 출력이 바뀐 자리만 고치고, 근거를 못 대는 수치는 지운다.

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const REPO = "https://github.com/kwakseongjae/auto-hwp";

// 측정 기준점 — 이 커밋의 워킹트리에서 재현 커맨드를 돌려 얻은 출력이다.
const MEASURED_AT = "2026-07-30";
const MEASURED_REV = "3cb5a7a";

const CLONE = `git clone --recurse-submodules ${REPO}
cd auto-hwp`;

type Row = { cells: React.ReactNode[] };

function Table({ head, rows }: { head: string[]; rows: Row[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.cells.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Repro({ label, code }: { label: string; code: string }) {
  return (
    <div className={styles.repro}>
      <div className={styles.reproLabel}>{label}</div>
      <pre className={styles.pre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function BenchPage() {
  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <nav className={styles.crumb}>
          <a href={`${BASE}/`}>오토한글</a>
          <span aria-hidden>›</span>
          <span>충실도 벤치마크</span>
          {/* 유일한 클라이언트 컴포넌트(테마 토글) — 이 페이지의 서버 렌더 계약은 그대로다.
              색은 전부 :root[data-theme] 토큰이라 토글이 다시 그리는 것은 자기 자신뿐이다. */}
          <ThemeToggle className={styles.themeToggle} />
        </nav>

        <p className={styles.kicker}>수동 육안이 아니라 자동 게이트</p>
        <h1 className={styles.title}>한글이 계산한 답과 대조합니다</h1>
        <p className={styles.lede}>
          &ldquo;원본과 비슷해 보인다&rdquo;는 검증이 아닙니다. 한글(HWP)은 문서를 저장할 때{" "}
          <b>자기가 계산한 줄바꿈 결과(lineseg)를 파일 안에 함께 적어 둡니다</b>. 오토한글은 같은 문서를
          자체 엔진으로 조판한 뒤 그 저장값과 문단 단위로 대조합니다 — 몇 쪽이 나왔는지, 어느 문단이
          몇 줄로 끊겼는지, 표 안 셀까지 재귀로. 사람 눈이 개입하지 않고, 점수가 떨어지면 커밋이
          막힙니다.
        </p>
        <p className={styles.stamp}>
          아래 수치는 <code>{MEASURED_REV}</code> 시점에 재현 커맨드를 그대로 실행해 얻은 출력입니다
          (측정 {MEASURED_AT}). 각 항목마다 커맨드를 함께 답니다 — 직접 돌려 확인하십시오.
        </p>

        <div className={styles.oracle}>
          <div className={styles.oracleCard}>
            <b>오라클 ① 저장된 lineseg</b>
            <p>
              한컴이 저장한 문단별 줄 정보. 우리가 만든 정답이 아니라 <b>한글이 실제로 계산한 결과</b>라
              해석의 여지가 없습니다.
            </p>
          </div>
          <div className={styles.oracleCard}>
            <b>오라클 ② rhwp 파싱</b>
            <p>
              바이너리 <code>.hwp</code>를 읽는 상류 파서(MIT). 파싱 전용으로만 씁니다 — 렌더는 항상 우리
              IR 에서 나옵니다.
            </p>
          </div>
          <div className={styles.oracleCard}>
            <b>게이트가 잠근다</b>
            <p>
              <code>scripts/verify-local.sh</code>가 쪽수 불일치 하나만 나와도 실패로 종료합니다. 수치는
              보고용이 아니라 <b>회귀 차단선</b>입니다.
            </p>
          </div>
        </div>

        {/* ── 1. 쪽수 게이트 ── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>쪽수 게이트</h2>
            <span className={styles.tag}>하드 게이트 · 불일치 시 빌드 실패</span>
          </div>
          <p className={styles.note}>
            같은 문서를 우리 조판기로 흘렸을 때 나오는 쪽수가 한컴 쪽수와 <b>정확히</b> 같아야 합니다.
            ±1 허용 같은 완충은 없습니다. 두 조판 경로(<code>place_doc</code> / <code>NaiveLayout</code>)의
            쪽수도 항상 서로 일치해야 합니다(LOCKSTEP).
          </p>
          <Table
            head={["문서", "우리", "한컴(rhwp)", "판정"]}
            rows={[
              { cells: [<span key="d" className={styles.doc}>benchmarks/benchmark.hwp</span>, "8", "8", <span key="v" className={styles.ok}>일치</span>] },
              { cells: [<span key="d" className={styles.doc}>benchmarks/benchmark1.hwp</span>, "18", "18", <span key="v" className={styles.ok}>일치</span>] },
              { cells: [<span key="d" className={styles.doc}>benchmarks/benchmark2.hwp</span>, "24", "24", <span key="v" className={styles.ok}>일치</span>] },
              {
                cells: [
                  <span key="d" className={styles.doc}>
                    modu-startup.hwp <span className={styles.sub}>(로컬 전용)</span>
                  </span>,
                  "6",
                  "6",
                  <span key="v" className={styles.ok}>일치</span>,
                ],
              },
            ]}
          />
          <p className={styles.note}>
            <b>modu-startup</b>은 실사용자 양식 실물이라 재배포할 수 없어 <code>corpus/private/</code>(git
            제외)에만 둡니다. 게이트는 파일이 있으면 6==6 을 강제하고, 없으면 점수를 꾸며내지 않고{" "}
            <b>skip 을 명시</b>합니다.
          </p>
          <Repro
            label="재현"
            code={`${CLONE}

# 4개 문서 쪽수 게이트를 한 번에 (verify-local.sh 가 도는 것과 같은 루프)
for b in benchmark benchmark1 benchmark2; do
  cargo run -q -p auto-hwp-cli --features "shaper rhwp" -- \\
    layout-check "benchmarks/\${b}.hwp" | grep 쪽수
done`}
          />
        </section>

        {/* ── 2. 본문 줄바꿈 ── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>본문 문단 줄바꿈 정확 일치율</h2>
            <span className={styles.tag}>98.9%+ 유지 게이트</span>
          </div>
          <p className={styles.note}>
            본문 문단 하나하나에 대해 <b>우리가 낸 줄 수</b>와 <b>한컴이 저장한 줄 수</b>를 비교합니다.
            &ldquo;정확 일치&rdquo;는 줄 수가 완전히 같은 문단의 비율, &ldquo;±1 이내&rdquo;는 한 줄 차이까지 허용한
            비율입니다. 실제 글꼴 폭(rustybuzz)으로 재는 <code>shaper</code> 경로 기준입니다.
          </p>
          <Table
            head={["문서", "대조 문단", "줄 수 정확 일치", "±1 이내", "총 줄 수 (우리 / 한컴)"]}
            rows={[
              { cells: [<span key="d" className={styles.doc}>benchmark.hwp</span>, "91", <span key="e"><b>90</b> <span className={styles.sub}>(98.9%)</span></span>, <span key="w" className={styles.ok}>91 (100.0%)</span>, "92 / 93"] },
              { cells: [<span key="d" className={styles.doc}>benchmark1.hwp</span>, "257", <span key="e"><b>255</b> <span className={styles.sub}>(99.2%)</span></span>, <span key="w" className={styles.ok}>257 (100.0%)</span>, "297 / 299"] },
              { cells: [<span key="d" className={styles.doc}>benchmark2.hwp</span>, "365", <span key="e"><b>364</b> <span className={styles.sub}>(99.7%)</span></span>, <span key="w" className={styles.ok}>365 (100.0%)</span>, "376 / 377"] },
            ]}
          />
          <p className={styles.note}>
            세 문서 모두 <b>±1 이내 100%</b> — 두 줄 이상 어긋나는 문단이 하나도 없습니다.
          </p>
          <Repro
            label="재현 (위 표 전체가 한 커맨드의 출력)"
            code={`cargo run -p auto-hwp-cli --features "shaper rhwp" -- \\
  layout-check benchmarks/benchmark1.hwp`}
          />
        </section>

        {/* ── 3. 셀 lineseg ── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>표 셀 안 줄바꿈 (재귀)</h2>
            <span className={styles.tag}>baseline 고정 테스트</span>
          </div>
          <p className={styles.note}>
            양식 문서는 내용의 대부분이 표 안에 있습니다 — <code>benchmark1.hwp</code>만 해도 표 밖
            문단이 257개인데 표 안 문단은 <b>839개</b>입니다. 본문 줄바꿈 지표는 <b>표 밖 문단만</b>{" "}
            재기 때문에, 중첩 표까지 재귀로 내려가 셀 안 문단의 lineseg 를 따로 대조하는 게이트를
            둡니다. 숫자는 테스트에 정확한 기대값으로 박혀 있어 한 문단만 어긋나도 실패합니다.
          </p>
          <Table
            head={["문서", "대조 셀 문단", "정확 일치", "±1 이내", "셀 총 줄 수 (우리 / 한컴)", "구조 불일치"]}
            rows={[
              { cells: [<span key="d" className={styles.doc}>benchmark.hwp</span>, "261", <span key="e"><b>261</b> <span className={styles.sub}>(100.0%)</span></span>, <span key="w" className={styles.ok}>261 (100.0%)</span>, "291 / 291", <span key="s" className={styles.ok}>0</span>] },
              { cells: [<span key="d" className={styles.doc}>benchmark1.hwp</span>, "839", <span key="e"><b>826</b> <span className={styles.sub}>(98.5%)</span></span>, <span key="w" className={styles.ok}>839 (100.0%)</span>, "969 / 978", <span key="s" className={styles.ok}>0</span>] },
              { cells: [<span key="d" className={styles.doc}>benchmark2.hwp</span>, "1,059", <span key="e"><b>1,042</b> <span className={styles.sub}>(98.4%)</span></span>, <span key="w" className={styles.ok}>1,059 (100.0%)</span>, "1,185 / 1,190", <span key="s" className={styles.ok}>0</span>] },
            ]}
          />
          <p className={styles.note}>
            <b>구조 불일치 0</b>은 두 쪽이 같은 표·같은 셀·같은 문단을 세고 있다는 뜻입니다(세는 대상이
            어긋나면 점수 자체가 무의미해집니다). <b>oracle 없음 0</b>도 함께 강제해, 한컴 저장값이 빠진
            문단을 조용히 건너뛰고 만점을 받는 일이 없게 합니다.
          </p>
          <Repro
            label="재현"
            code={`# ① 게이트 테스트 (기대값이 코드에 박혀 있다)
cargo test -p hwp-rhwp --features "rhwp shaper" cell_lineseg

# ② 어느 셀이 왜 어긋났는지 감사 — 셀 폭·좌우 패딩·텍스트까지 출력
cargo run -p auto-hwp-cli --features "shaper rhwp" -- \\
  layout-check benchmarks/benchmark1.hwp --cells all`}
          />
        </section>

        {/* ── 4. 캐럿 ── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>본문 캐럿 좌표 교차검증</h2>
            <span className={styles.tag}>8+18+24쪽 · 563 밴드</span>
          </div>
          <p className={styles.note}>
            조판이 맞아도 <b>클릭한 자리에 커서가 서지 않으면</b> 편집기로서는 실패입니다. 세 벤치마크
            문서의 모든 줄 밴드를 훑으면서, 엔진이 돌려준 캐럿 사각형과 히트테스트 결과가 서로
            왕복하는지 확인합니다.
          </p>
          <Table
            head={["검사 항목", "결과"]}
            rows={[
              { cells: ["히트 결과가 질의한 쪽 안에 캐럿을 담는가 (page-local)", <span key="a" className={styles.ok}>1,825 / 1,825</span>] },
              { cells: ["캐럿 사각형 → 히트테스트 왕복 (주소·오프셋 복원)", <span key="a" className={styles.ok}>431 / 431</span>] },
              { cells: ["글리프 baseline 이 엔진 LineSeg 캐럿 상자 안에 있는가", <span key="a" className={styles.ok}>431 / 431</span>] },
              { cells: ["보이는 글리프의 x 좌표 일치", <span key="a" className={styles.ok}>431 / 431</span>] },
              { cells: ["질의 3,227건 p95 응답", <span key="a">0.123 ms <span className={styles.sub}>(기기 의존)</span></span>] },
            ]}
          />
          <p className={styles.note}>
            응답 시간은 측정 기기에 따라 달라집니다 — 레포 기록상 같은 스크립트의 p95 는 0.081~0.155ms
            범위에서 움직였습니다. 반면 위 네 개의 일치 카운트는 <b>결정론적</b>이라 기기와 무관합니다.
          </p>
          <Repro
            label="재현 (wasm 을 먼저 빌드해야 한다)"
            code={`cargo build -p hwp-wasm --profile wasm-size --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg \\
  target/wasm32-unknown-unknown/wasm-size/hwp_wasm.wasm
node packages/engine/bench/body-caret-crosscheck.mjs`}
          />
        </section>

        {/* ── 5. HWPX 파리티 ── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>HWPX 파서 파리티</h2>
            <span className={styles.tag}>입력을 잠그는 오라클</span>
          </div>
          <p className={styles.note}>
            <code>.hwp</code>는 rhwp 로, <code>.hwpx</code>는 우리 자체 파서로 읽습니다. 두 경로가 같은
            문서에서 다른 IR 을 만들면 조판은 조용히 갈라집니다. 그래서 같은{" "}
            <code>benchmark1.hwpx</code>를 두 파서로 각각 읽고, <b>엔진을 고정한 채</b> 결과를
            대조합니다. 쪽수 게이트가 <i>결과</i>를 잠근다면 이 테스트는 <i>입력</i>을 잠급니다.
          </p>
          <Table
            head={["항목", "우리 HWPX 파서", "rhwp 경로", "판정"]}
            rows={[
              { cells: ["문단 수", "325", "325", <span key="v" className={styles.ok}>일치</span>] },
              { cells: ["표 수", "67", "67", <span key="v" className={styles.ok}>일치</span>] },
              { cells: ["조판 쪽수", "22", "22", <span key="v" className={styles.ok}>일치</span>] },
              { cells: ["조판 총 줄 수", "301", "301", <span key="v" className={styles.ok}>일치</span>] },
              { cells: ["하이퍼링크 필드쌍 회수", "1 / 1", "—", <span key="v" className={styles.ok}>보존</span>] },
            ]}
          />
          <p className={styles.note}>
            총 줄 수는 구조 회귀의 가장 예민한 탐지기입니다 — 표 앵커 문단을 잘못 세면 표 개수만큼
            빈 줄이 초과 예약돼(실측 368 vs 301) 바로 드러납니다.{" "}
            <b>이 표는 &ldquo;두 파서가 같다&rdquo;는 뜻이지 &ldquo;22쪽이 참값&rdquo;이라는 뜻이 아닙니다</b> — 아래 한계를
            보십시오.
          </p>
          <Repro
            label="재현"
            code={`cargo test -p hwp-core --features rhwp --test hwpx_rhwp_parity -- --nocapture`}
          />
        </section>

        {/* ── 6. 한계 ── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>이 수치가 말하지 않는 것</h2>
            <span className={styles.tag}>정직 고지</span>
          </div>
          <ul className={styles.limits}>
            <li>
              <b>한컴 네이티브 참값 오라클은 아직 없습니다.</b> 지금의 정답지는 &ldquo;한글이 파일에 저장해 둔
              값&rdquo;과 &ldquo;rhwp 파싱&rdquo;입니다. 한글을 실제로 실행시켜(Windows COM) 그 결과를 참값으로 쓰는
              nightly 레인은 미완이며 이슈 075 로 열려 있습니다.
            </li>
            <li>
              <b>HWPX 입력의 절대 쪽수는 아직 정답이 아닙니다.</b> 같은 문서라도{" "}
              <code>benchmark1.hwpx</code>를 우리 HWPX 파서로 읽으면 22쪽, rhwp 참조로는 25쪽이 나옵니다
              (<code>layout-check benchmarks/benchmark1.hwpx</code>로 직접 확인할 수 있습니다). 위 파리티
              표와 HWPX 관련 게이트는 <b>회귀를 잠그는 장치</b>이지 참값 주장이 아닙니다. 이슈 074 에서
              네 갈래(본문 상자·세로 병합 셀·ragged 표·행 높이 바닥)를, 080 에서 두 갈래(명시적 쪽 나누기
              누락·<code>noAdjust=&quot;1&quot;</code> 표 행 높이 과다 예약)를 해소했습니다. 그 뒤에도 남는
              22 vs 25 는 줄/행 높이 참값 축이라 075 로 넘어갑니다.
            </li>
            <li>
              <b>레포 기록(재현 불가 표본).</b> 한컴이 저작한 HWPX 5종을 production 파서로 재측정했을 때
              4종은 한컴 쪽수와 정확히 같았고 <code>bizinfo-mss__붙임1</code> 하나만 우리 24 vs 한컴 25
              였습니다(이슈 080). 080 해소 후 2026-07-30 재실측에서 <b>25 == 25 로 일치</b>합니다. 해당
              문서들은 공개 코퍼스가 아니라 이 수치는 <b>직접 재현할 수 없습니다</b> — 그래서 위 표에
              섞지 않고 여기 따로 적습니다.
            </li>
            <li>
              <b>modu-startup 6==6 은 로컬 전용 벤치입니다.</b> 실사용자 양식 실물이라 공개 재배포가
              불가능해 <code>corpus/private/</code>에만 존재합니다. 클론한 레포에서는 이 게이트가 skip
              으로 표시됩니다.
            </li>
            <li>
              <b>줄바꿈 지표는 &ldquo;줄 개수&rdquo; 충실도입니다.</b> 어느 글자에서 줄이 끊겼는지가 아니라 몇 줄로
              끊겼는지를 셉니다. 글자 x 좌표는 이 지표가 아니라 위 <b>캐럿 교차검증</b>이 따로 잽니다.
            </li>
            <li>
              <b>벤치마크 밖 문서의 완전 일치는 보증하지 않습니다.</b> 게이트가 도는 문서는 위 4종이
              전부입니다. 다단·세로쓰기·개체 어울림(float/wrap)은 미구현이고, 함초롬 등 상용 서체는
              번들하지 않아 OFL 대체(나눔 계열)로 렌더되므로 글리프 메트릭의 미세 차이가 남습니다.
            </li>
          </ul>
        </section>

        {/* ── 7. 전부 한 번에 ── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>전부 한 번에 돌리기</h2>
          </div>
          <p className={styles.note}>
            위 게이트는 전부 하나의 스크립트 안에 있습니다. 이 스크립트가 그린이 아니면 머지하지
            않는다는 것이 프로젝트 규율입니다.
          </p>
          <Repro
            label="검증 정본"
            code={`scripts/verify-local.sh          # fmt · clippy · 전체 테스트 · 쪽수 게이트 · wasm 위생
scripts/verify-local.sh --full   # + wasm 재빌드 · 캐럿 교차검증 · JS 빌드/유닛 · E2E`}
          />
        </section>

        <div className={styles.footer}>
          <a href={`${BASE}/`}>← 데모로 돌아가기</a>
          <span aria-hidden>·</span>
          <a href={`${REPO}/blob/main/docs/BENCHMARK.md`} target="_blank" rel="noreferrer">
            방법론 전문 (BENCHMARK.md) ↗
          </a>
          <span aria-hidden>·</span>
          <a href={`${REPO}/blob/main/docs/CLI-GUIDE.md`} target="_blank" rel="noreferrer">
            CLI 가이드 ↗
          </a>
          <span aria-hidden>·</span>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </div>
    </main>
  );
}
