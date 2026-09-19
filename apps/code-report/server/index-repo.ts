// Indexes titan-platform into the graph the report daemon serves: `pnpm --filter code-report index`.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { indexPaths, openCodeGraph } from "@titan-design/code-graph";
import { DB_PATH, INDEXED_DIRS, REPO_ROOT } from "./paths.js";

function currentRef(): string {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return branch === "HEAD" ? "detached" : branch;
}

async function main(): Promise<void> {
  const store = openCodeGraph(DB_PATH);
  const started = performance.now();
  const commitHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const result = await indexPaths(store, {
    paths: INDEXED_DIRS.map((dir) => path.join(REPO_ROOT, dir)),
    ref: currentRef(),
    commitHash,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`indexed ${result.files} files, ${result.nodes} nodes, ${result.edges} edges -> snapshot ${result.snapshotId} in ${seconds}s (${DB_PATH})`);
}

await main();
