import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export interface MergedPr {
  base: string;
  merge: string;
}

/** Base B on main, then a merge commit M whose second parent adds `src/x.ts`, `src/x.test.ts` and `src/fixtures/x.json`. */
export function buildMergedPr(clone: string, extra: Record<string, string> = {}): MergedPr {
  git(clone, "init", "-q", "-b", "main");
  const base = commit(clone, { "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "it('a', () => {});\n" }, "base");
  git(clone, "checkout", "-q", "-b", "pr");
  commit(clone, { "src/x.ts": "export const x = 2;\n", "src/x.test.ts": "it('x', () => {});\n", "src/fixtures/x.json": "{\"x\": 2}\n", ...extra }, "pr head");
  git(clone, "checkout", "-q", "main");
  git(clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "Merge pr", "pr");
  return { base, merge: git(clone, "rev-parse", "HEAD") };
}
