// Safely pack/publish @auto-hwp/react with registry dependencies.
//
// The source manifest deliberately keeps file: links for local development. Mutating it in npm's
// prepack/postpack lifecycle is unsafe: if npm fails after prepack (bad cache, auth, registry, disk),
// postpack is not guaranteed to run and the worktree is left in publish mode. This wrapper owns the
// whole operation and restores the source manifest in finally, while the nested npm command runs
// with lifecycle scripts disabled.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const [operation, ...forwarded] = process.argv.slice(2);

if (operation !== "pack" && operation !== "publish") {
  console.error("usage: with-publish-deps.mjs pack|publish [npm args...]");
  process.exit(2);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 1}`;
    throw new Error(`${command} ${args.join(" ")} failed (${detail})`);
  }
}

let publishMode = false;
let operationError;
try {
  run("npm", ["run", "build"]);
  run("node", ["scripts/rewrite-workspace-deps.mjs", "--publish"]);
  publishMode = true;
  run("npm", [operation, "--ignore-scripts", ...forwarded]);
} catch (error) {
  operationError = error;
} finally {
  if (publishMode) {
    try {
      run("node", ["scripts/rewrite-workspace-deps.mjs", "--dev"]);
    } catch (restoreError) {
      operationError = new AggregateError(
        [operationError, restoreError].filter(Boolean),
        "pack/publish failed and the local manifest could not be restored",
      );
    }
  }
}

if (operationError) throw operationError;
