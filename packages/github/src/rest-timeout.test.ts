import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import { execGh, type GhExec, type GhExecOptions } from "./exec.js";
import { CORE_TIMEOUT_MS, GRAPHQL_TIMEOUT_MS, restCaller } from "./rest.js";

// Per-run so a concurrent run of this suite on the same host cannot count or kill our sleepers via host-wide pgrep/pkill.
const MARKER = `tp2933-fake-gh-sleeper-${process.pid}-${randomBytes(4).toString("hex")}`;
const dirs: string[] = [];
const savedPath = process.env.PATH;
const noSleep = async (): Promise<void> => undefined;

afterEach(() => {
  process.env.PATH = savedPath;
  try {
    execFileSync("pkill", ["-KILL", "-f", MARKER]);
  } catch {
    // pkill exits 1 when nothing matched
  }
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function pgrepCount(): number {
  try {
    return execFileSync("pgrep", ["-f", MARKER], { encoding: "utf8" }).trim().split("\n").length;
  } catch {
    return 0;
  }
}

// cp writes in a process that has exited before the first exec, so no forked sibling can hold a write fd (ETXTBSY).
function installHungGh(): void {
  const dir = mkdtempSync(join(tmpdir(), `${MARKER}-`));
  dirs.push(dir);
  const script = join(dir, "gh");
  writeFileSync(`${script}.staging`, `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nsetTimeout(() => undefined, 60000);\n`);
  chmodSync(`${script}.staging`, 0o755);
  execFileSync("cp", ["-p", `${script}.staging`, script]);
  rmSync(`${script}.staging`);
  process.env.PATH = `${dir}:${savedPath}`;
}

/** The real `execGh`, shortened to 300 ms, but only when rest asked for a timeout: without one the call still hangs. */
function shortenedExecGh(calls: { count: number } = { count: 0 }): GhExec {
  return (args, input, options) => {
    calls.count += 1;
    return execGh(args, input, { ...options, timeoutMs: options?.timeoutMs === undefined ? undefined : 300 });
  };
}

async function expectNoChildLeft(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(pgrepCount()).toBe(0);
}

describe("restCaller timeouts", () => {
  it("sends the core timeout on every core call and the GraphQL timeout on graphql", async () => {
    const seen: (GhExecOptions | undefined)[] = [];
    const exec: GhExec = async (_args, _input, options) => {
      seen.push(options);
      return { code: 0, stdout: "HTTP/2.0 200 OK\n\n[]", stderr: "" };
    };
    const rest = restCaller(exec, rateBudget(), 10, noSleep);

    await rest.get("repos/o/r");
    await rest.pages("repos/o/r/pulls", {}, (page: unknown[]) => page);
    await rest.revalidatePages("repos/o/r/issues", {}, null, (page: unknown[]) => page);
    await rest.text("repos/o/r/actions/jobs/1/logs");
    await rest.send("POST", "repos/o/r/issues/1/comments");
    const core = seen.splice(0);
    await rest.send("POST", "graphql");

    expect(core.map((options) => options?.timeoutMs)).toEqual(Array(5).fill(CORE_TIMEOUT_MS));
    expect(seen.map((options) => options?.timeoutMs)).toEqual([GRAPHQL_TIMEOUT_MS]);
  });

  it("rejects a write to a hung gh with a timeout and leaves no gh child", { timeout: 5_000 }, async () => {
    installHungGh();
    const rest = restCaller(shortenedExecGh(), rateBudget(), 10, noSleep);

    await expect(rest.send("POST", "repos/o/r/git/refs", { ref: "refs/heads/x", sha: "abc" })).rejects.toThrow(/timed out after 300 ms/);

    await expectNoChildLeft();
  });

  it("rejects a read from a hung gh with a timeout, once, without retrying", { timeout: 5_000 }, async () => {
    installHungGh();
    const calls = { count: 0 };
    let sleeps = 0;
    const rest = restCaller(shortenedExecGh(calls), rateBudget(), 10, async () => {
      sleeps += 1;
    });

    await expect(rest.get("repos/o/r")).rejects.toThrow(/timed out after 300 ms/);

    expect(calls.count).toBe(1);
    expect(sleeps).toBe(0);
    await expectNoChildLeft();
  });
});
