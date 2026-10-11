import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { spawnExec, type Exec } from "./exec.js";
import { parseResultLine, type FixProofResult } from "./result-line.js";
import { run } from "./run.js";

const VITEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules/vitest/vitest.mjs");
const BUGGY = "export const add = (a: number, b: number) => a - b;\n";
const FIXED = "export const add = (a: number, b: number) => a + b;\n";
const REAL_TEST = 'import { add } from "./math";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
const VACUOUS_TEST = 'import { add } from "./math";\ntest("adds zero", () => expect(add(0, 0)).toBe(0));\n';
const repos: string[] = [];

interface Repo {
  dir: string;
  base: string;
  commit(files: Record<string, string>): string;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

function makeRepo(config: Record<string, string> = {}): Repo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-run-"));
  repos.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.hooksPath", "/dev/null"]);
  const commit = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "change"]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const fixProofConfig = { command: `node ${VITEST} run --globals`, build: "true", ...config };
  const base = commit({ "src/math.ts": BUGGY, ".github/fix-proof.json": JSON.stringify(fixProofConfig) });
  return { dir, base, commit };
}

function parsed(line: string): FixProofResult {
  const result = parseResultLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}

afterEach(() => {
  repos.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("fix-proof run", { timeout: 120_000 }, () => {
  it("reproduces a real test against the base's unfixed source", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head }));

    expect(result).toMatchObject({ head, mergeBase: repo.base, verdict: "reproduced" });
    expect(result.tests).toEqual([{ file: "src/math.test.ts", name: "adds", class: "reproduces" }]);
  });

  it("calls a test vacuous after running the base a second time", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": VACUOUS_TEST });
    const reports: string[] = [];
    const exec: Exec = (file, args, options) => {
      const out = args[args.indexOf("--outputFile") + 1];
      if (args.includes("--outputFile") && out !== undefined) reports.push(path.basename(out));
      return spawnExec(file, args, options);
    };

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head, exec }));

    expect(result.verdict).toBe("vacuous");
    expect(reports).toEqual(["head.json", "base.json", "base-rerun.json"]);
  });

  it("does not carry a new src module, so a test of it is unproven on base", async () => {
    const repo = makeRepo();
    const head = repo.commit({
      "src/sum.ts": 'export { add } from "./math";\n',
      "src/math.ts": FIXED,
      "src/sum.test.ts": 'import { add } from "./sum";\ntest("sums", () => expect(add(2, 2)).toBe(4));\n',
    });

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head }));

    expect(result.verdict).toBe("unproven");
    expect(result.tests).toEqual([{ file: "src/sum.test.ts", name: "sums", class: "new-api" }]);
  });

  it("carries a new test-support helper, so the base fails on the assertion", async () => {
    const repo = makeRepo();
    const head = repo.commit({
      "src/math.ts": FIXED,
      "src/test-support/expected.ts": "export const three = 3;\n",
      "src/math.test.ts": 'import { add } from "./math";\nimport { three } from "./test-support/expected";\ntest("adds", () => expect(add(1, 2)).toBe(three));\n',
    });

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head }));

    expect(result.verdict).toBe("reproduced");
  });

  it("prints an error line instead of throwing when the build crashes", async () => {
    const repo = makeRepo({ build: "exit 3" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });

    const result = parsed(await runCli(["run", "--base", repo.base, "--head", head, "--repo", repo.dir], repo.dir));

    expect(result).toMatchObject({ head, mergeBase: repo.base, verdict: "error", error: "base: build failed (exit 3)" });
  });

  it("prints a timeout error line when the budget runs out", async () => {
    const repo = makeRepo({ build: "sleep 5" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head, budgetMs: 1_500 }));

    expect(result).toMatchObject({ verdict: "error", error: "timeout" });
    expect(git(repo.dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("prints a no-tests line when the diff touches no test", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED });

    expect(parsed(await run({ repo: repo.dir, base: repo.base, head })).verdict).toBe("no-tests");
  });

  it("prints an error line for arguments it cannot use", async () => {
    const result = parsed(await runCli(["run", "--head", "HEAD"], os.tmpdir()));

    expect(result).toMatchObject({ verdict: "error", head: "0".repeat(40) });
    expect(result.error).toContain("usage: fix-proof run");
  });
});
