/// 이 패키지의 존재 이유를 강제하는 테스트 (이슈 268).
///
/// > `src/tauri.ts` 바깥에서 `@tauri-apps/*` 를 import 하는 곳이 0건.
///
/// 이걸 문서로만 적어 두면 다음 사람이(또는 다음 나가) 급할 때 한 줄 import 하고 지나간다. 그러면
/// 패키지는 남지만 규율은 사라지고, #260 같은 일이 다시 생긴다 — 호스트 능력이 한쪽 셸에만 붙는 일.
/// **테스트가 실패해야 규칙이다.**
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/// `dir/.git` 이 저장소 표지인가. 일반 클론은 디렉터리이고, `git worktree add` 로 만든 작업 폴더는
/// `gitdir: <본 저장소>/.git/worktrees/<이름>` 한 줄이 든 **파일**이다(#548 — 디렉터리만 받던 탓에 워크트리에서
/// 이 시험이 불러오기부터 죽었다). 그 밖의 `.git` 이름 파일은 표지로 받지 않는다 — 상위 폴더의 엉뚱한 파일에서
/// 멈추면 검사 범위가 조용히 바뀐다.
function isRepoMarker(gitPath: string): boolean {
  try {
    const st = statSync(gitPath);
    if (st.isDirectory()) return true;
    return st.isFile() && readFileSync(gitPath, "utf8").startsWith("gitdir:");
  } catch {
    return false; // 없거나 읽을 수 없으면 표지가 아니다 — 계속 올라간다
  }
}

/** `start` 에서 위로 올라가며 저장소 뿌리(`.git` 표지가 있는 폴더)를 찾는다. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (isRepoMarker(join(dir, ".git"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  throw new Error("저장소 뿌리를 찾지 못했다 (.git)");
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/// 검사 대상 — 우리가 쓰는 TS/TSX 소스 전부.
const SCAN = [
  "crates/hwp-viewer/ui/src",
  "packages/platform/src",
  "packages/react/src",
  "packages/editor-core/src",
  "packages/ai-protocol/src",
  "apps/hwp-lab/src",
];

/// 유일한 예외. 이 목록이 길어지면 패키지가 실패하고 있다는 뜻이다.
const ALLOWED = new Set(["packages/platform/src/tauri.ts"]);

/// 주석 속 언급이 아니라 **실제 import** 만 잡는다 — `TauriAdapter.ts` 는 주석에서 `@tauri-apps/api/core`
/// 를 언급하지만 물지는 않는다(주입받는다). 그 파일을 잘못 잡으면 가드가 거짓 경보를 내는 것이다.
const IMPORTS_TAURI = /(?:^|\n)\s*import\s[^\n;]*from\s*["']@tauri-apps\/|(?:import|require)\s*\(\s*["']@tauri-apps\//;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 아직 없는 트리는 건너뛴다 (패키지가 추가·삭제될 수 있다)
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("호스트 경계", () => {
  it("src/tauri.ts 밖에서는 아무도 @tauri-apps/* 를 import 하지 않는다", () => {
    const offenders: string[] = [];
    for (const tree of SCAN) {
      for (const file of walk(join(ROOT, tree))) {
        const rel = relative(ROOT, file);
        if (ALLOWED.has(rel)) continue;
        if (IMPORTS_TAURI.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `호스트 능력은 @auto-hwp/platform 을 거쳐야 한다 (이슈 268). 위반:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("허용 파일은 실제로 존재한다 — 예외가 유령이 되지 않게", () => {
    for (const rel of ALLOWED) expect(statSync(join(ROOT, rel)).isFile()).toBe(true);
  });
});

describe("저장소 뿌리 찾기 (#548)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "auto-hwp-repo-root-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** `root/.git` 표지와 그 아래 `packages/platform/src` 를 만들고, 그 시작 폴더를 돌려준다. */
  function tree(root: string, marker: "dir" | { file: string }): string {
    const start = join(root, "packages", "platform", "src");
    mkdirSync(start, { recursive: true });
    if (marker === "dir") mkdirSync(join(root, ".git"));
    else writeFileSync(join(root, ".git"), marker.file);
    return start;
  }

  it("일반 클론 — `.git` 디렉터리", () => {
    const root = join(tmp, "clone");
    expect(findRepoRoot(tree(root, "dir"))).toBe(root);
  });

  it("git 워크트리 — `gitdir:` 로 시작하는 `.git` 파일", () => {
    const root = join(tmp, "wt");
    expect(findRepoRoot(tree(root, { file: "gitdir: /somewhere/repo/.git/worktrees/wt\n" }))).toBe(root);
  });

  it("`gitdir:` 가 아닌 `.git` 파일은 건너뛰고 위의 진짜 뿌리를 찾는다", () => {
    const outer = join(tmp, "outer");
    mkdirSync(join(outer, ".git"), { recursive: true });
    expect(findRepoRoot(tree(join(outer, "inner"), { file: "not a git pointer\n" }))).toBe(outer);
  });
});
