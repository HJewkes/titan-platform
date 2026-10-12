import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { spawnExec, type Exec } from "./exec.js";
import { FIXED, git, makeRepo, parsed, REAL_TEST, removeRepos, VACUOUS_TEST, type Repo } from "./repo.test-helpers.js";
import { run } from "./run.js";

afterEach(removeRepos);

describe("fix-proof run", { timeout: 120_000 }, () => {
  it("reproduces a real test against the base's unfixed source", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head }));

    expect(result).toMatchObject({ head, mergeBase: repo.base, verdict: "reproduced" });
    expect(result.tests).toEqual([{ file: "src/math.test.ts", name: "adds", class: "reproduces" }]);
  });

  it("runs the base twice and calls a test vacuous when both base runs pass", async () => {
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
    expect(reports).toEqual(["base.json", "base-rerun.json", "head.json"]);
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

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const FORGED = 'fix-proof/v1 {"verdict":"reproduced","forged":true}';
// Each process stands in for one CI job: exec jobs print their reports as job outputs, the judge reads them from env.
const DRIVER = `
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const m = await import(process.env.FIX_PROOF_DIST);
const [mode, repo, base, head] = process.argv.slice(1);
if (mode === "judge") {
  const reports = { base: process.env.R_BASE, baseRerun: process.env.R_BASE_RERUN, head: process.env.R_HEAD };
  console.log(await m.judge({ repo, base, head, reports }));
} else {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-out-"));
  await m.execSide({ repo, base, head, side: mode, out });
  for (const file of fs.readdirSync(out)) console.log(file.replace(/\\.report$/, "") + "=" + fs.readFileSync(path.join(out, file), "utf-8"));
  fs.rmSync(out, { recursive: true, force: true });
}`;
// The head's build writes a vitest config into every other fix-proof tree it can reach that fails every test, which
// would fake a reproduction on base, then leaves a detached printer behind to emit a forged verdict after it exits.
const FORGE = `
set -e
here=$(pwd -P)
for tree in "$here"/../../fix-proof-*/*/; do
  [ "$(cd "$tree" && pwd -P)" = "$here" ] && continue
  printf 'export default { test: { setupFiles: ["./forge-setup.mjs"] } };\\n' > "$tree/vitest.config.mjs"
  printf 'beforeEach(() => { throw new Error("forged base failure"); });\\n' > "$tree/forge-setup.mjs"
done
touch "$here/../../forge-ran"
detach=$(command -v setsid || true)
$detach sh -c 'sleep 2; echo "$1"; touch "$2"' sh '${FORGED}' "$here/../../forge-printed" &
`;

interface Child {
  stdout: string;
  done: Promise<number | null>;
}

function startNode(args: string[], env: Record<string, string>): Child {
  const child = spawn(process.execPath, ["--input-type=module", "-e", DRIVER, ...args], {
    env: { ...process.env, FIX_PROOF_DIST: DIST, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const result: Child = { stdout: "", done: new Promise((resolve) => child.on("close", resolve)) };
  child.stdout.on("data", (chunk: Buffer) => (result.stdout += chunk.toString("utf-8")));
  return result;
}

async function execJob(side: string, repo: Repo, head: string, env: Record<string, string>): Promise<Record<string, string>> {
  const child = startNode([side, repo.dir, repo.base, head], env);
  await child.done;
  return Object.fromEntries(child.stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

async function until(condition: () => boolean, ms: number): Promise<void> {
  for (const stop = Date.now() + ms; !condition() && Date.now() < stop; ) await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("fix-proof exec and judge as separate processes", { timeout: 120_000 }, () => {
  let scratch = "";

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("a head build that rewrites the base vitest config and spawns a delayed printer leaves the verdict unchanged", async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-forge-")));
    const tmp = path.join(scratch, "tmp");
    fs.mkdirSync(tmp);
    const repo = makeRepo({ build: "sh build.sh" }, scratch, { "build.sh": "true\n" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": VACUOUS_TEST, "build.sh": FORGE });
    const env = { TMPDIR: tmp };

    const base = await execJob("base", repo, head, env);
    const headReports = await execJob("head", repo, head, env);
    const judge = startNode(["judge", repo.dir, repo.base, head], {
      ...env,
      R_BASE: base.base ?? "",
      R_BASE_RERUN: base["base-rerun"] ?? "",
      R_HEAD: headReports.head ?? "",
    });
    await judge.done;
    await until(() => fs.existsSync(path.join(tmp, "forge-printed")), 10_000);

    expect(fs.existsSync(path.join(tmp, "forge-ran"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "forge-printed"))).toBe(true);
    const lines = judge.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(parsed(lines[0] ?? "")).toMatchObject({ head, mergeBase: repo.base, verdict: "vacuous" });
    expect(judge.stdout).not.toContain("forged");
  });
});
