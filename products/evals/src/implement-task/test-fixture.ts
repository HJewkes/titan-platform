import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterAll } from "vitest";

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface MergedPr {
  base: string;
  merge: string;
}

function writeMergedPr(dir: string, extra: Record<string, string>): MergedPr {
  seedRepo(dir, {});
  const [base = ""] = withHistory(dir, [
    { message: "base", files: { "src/a.ts": "export const a = 1;\n", "src/a.test.ts": "it('a', () => {});\n" } },
    { message: "pr head", branch: "pr", from: "main", files: { "src/x.ts": "export const x = 2;\n", "src/x.test.ts": "it('x', () => {});\n", "src/fixtures/x.json": "{\"x\": 2}\n", ...extra } },
  ]);
  const run = gitIn(dir);
  run("checkout", "-q", "main");
  run("merge", "-q", "--no-ff", "-m", "Merge pr", "pr");
  return { base, merge: run("rev-parse", "HEAD") };
}

// A merged PR costs a dozen git processes; each test file builds each variant once and copies it into every test's clone.
const built = new Map<string, { dir: string; pr: MergedPr }>();

afterAll(() => {
  for (const { dir } of built.values()) rmSync(dir, { recursive: true, force: true });
  built.clear();
});

/** Base B on main, then a merge commit M whose second parent adds `src/x.ts`, `src/x.test.ts` and `src/fixtures/x.json`. */
export function buildMergedPr(clone: string, extra: Record<string, string> = {}): MergedPr {
  const key = JSON.stringify(extra);
  let template = built.get(key);
  if (!template) {
    const dir = mkdtempSync(join(tmpdir(), "merged-pr-"));
    template = { dir, pr: writeMergedPr(join(dir, "repo"), extra) };
    built.set(key, template);
  }
  cpSync(join(template.dir, "repo"), clone, { recursive: true });
  return template.pr;
}
