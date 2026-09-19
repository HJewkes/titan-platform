import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/code-report, whichever script imports this. */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The git toplevel the index is taken from; excerpts are read from this working tree. */
export const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: APP_DIR, encoding: "utf8" }).trim();

/** Same place codewatch keeps its graph, already gitignored. */
export const DB_PATH = process.env.CODE_REPORT_DB ?? path.join(REPO_ROOT, ".codewatch/graph.db");

/** The findings' rules; defaults to the repo's own, which CI keeps at zero violations. */
export const RULES_PATH = path.resolve(REPO_ROOT, process.env.CODE_REPORT_RULES ?? ".codewatch/check.json");

export const DIST_DIR = path.join(APP_DIR, "dist");

/** Off the daemon package's default 7400 so the report can run beside other titan daemons. */
export const DAEMON_PORT = Number(process.env.CODE_REPORT_PORT ?? 7411);

export const INDEXED_DIRS = ["packages", "products", "apps"];
