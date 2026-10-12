import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseResultLine, type FixProofResult } from "./result-line.js";

const VITEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules/vitest/vitest.mjs");
const BUGGY = "export const add = (a: number, b: number) => a - b;\n";
export const FIXED = "export const add = (a: number, b: number) => a + b;\n";
export const REAL_TEST = 'import { add } from "./math";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
export const VACUOUS_TEST = 'import { add } from "./math";\ntest("adds zero", () => expect(add(0, 0)).toBe(0));\n';

export interface Repo {
  dir: string;
  base: string;
  commit(files: Record<string, string>): string;
}

export function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

/** A git repo whose first commit holds the buggy module and a fix-proof config running this checkout's vitest; removed by removeRepos. */
export function makeRepo(config: Record<string, string> = {}, parent: string = os.tmpdir(), files: Record<string, string> = {}): Repo {
  const dir = fs.mkdtempSync(path.join(parent, "fix-proof-run-"));
  repos.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.hooksPath", "/dev/null"]);
  const commit = (changes: Record<string, string>) => {
    for (const [file, text] of Object.entries(changes)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "change"]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const fixProofConfig = { command: `node ${VITEST} run --globals`, build: "true", ...config };
  const base = commit({ "src/math.ts": BUGGY, ".github/fix-proof.json": JSON.stringify(fixProofConfig), ...files });
  return { dir, base, commit };
}

const repos: string[] = [];

export function removeRepos(): void {
  repos.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
}

export function parsed(line: string): FixProofResult {
  const result = parseResultLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
