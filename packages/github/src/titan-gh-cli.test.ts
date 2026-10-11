import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeSha, successRun } from "./fake.js";
import { githubPort, type CheckRun } from "./port.js";
import { runTitanGh } from "./titan-gh-cli.js";

const SHA = fakeSha("head");

async function titanGh(args: string[], runs: CheckRun[] = [successRun("build", 1)]): Promise<{ code: number; out: string[]; err: string[] }> {
  const fake = fakeGitHub();
  fake.rules = { contexts: [], strict: false };
  fake.setRuns(SHA, runs);
  const out: string[] = [];
  const err: string[] = [];
  let now = 0;
  const code = await runTitanGh(args, {
    port: githubPort(fake.wire),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => now,
    sleep: async (ms) => void (now += ms),
  });
  return { code, out, err };
}

describe("titan-gh ci-wait", () => {
  it("prints GREEN and exits 0 when CI is green", async () => {
    expect(await titanGh(["ci-wait", "o/r", SHA])).toEqual({ code: 0, out: [`GREEN o/r ${SHA}`], err: [] });
  });

  it("prints RED and exits 1 when CI is red", async () => {
    expect(await titanGh(["ci-wait", "o/r", SHA], [successRun("unit", 1, undefined, "failure")])).toEqual({ code: 1, out: [`RED o/r ${SHA}: unit=failure`], err: [] });
  });

  it("prints TIMEOUT and exits 2 when CI is still pending at the deadline", async () => {
    const pending = [{ ...successRun("build", 1), status: "in_progress", conclusion: null }];

    expect(await titanGh(["ci-wait", "o/r", SHA, "--timeout", "1", "--interval", "1"], pending)).toEqual({ code: 2, out: [`TIMEOUT o/r ${SHA} after 1s: pending build`], err: [] });
  });

  it("accepts an upper-case abbreviation and prints the full sha", async () => {
    expect(await titanGh(["ci-wait", "o/r", SHA.slice(0, 7).toUpperCase(), "--interval", "0"])).toMatchObject({ code: 0, out: [`GREEN o/r ${SHA}`] });
  });

  it("exits 64 on a sha GitHub does not have, on stderr", async () => {
    expect(await titanGh(["ci-wait", "o/r", "abc1234"])).toEqual({ code: 64, out: [], err: ["need a full 40-hex sha of a pushed commit: no commit abc1234 in o/r"] });
  });

  it.each([
    ["no args", []],
    ["an unknown verb", ["ci-watch", "o/r", SHA]],
    ["a missing sha", ["ci-wait", "o/r"]],
    ["a repo without a slash", ["ci-wait", "norepo", SHA]],
    ["a repo with shell characters", ["ci-wait", "o/r;x", SHA]],
    ["a repo with an extra slash", ["ci-wait", "a/b/c", SHA]],
    ["a non-numeric timeout", ["ci-wait", "o/r", SHA, "--timeout", "x"]],
    ["an unknown flag", ["ci-wait", "o/r", SHA, "--bogus"]],
    ["a flag without a value", ["ci-wait", "o/r", SHA, "--interval"]],
    ["a sha shorter than 7", ["ci-wait", "o/r", "abc12"]],
    ["a non-hex sha", ["ci-wait", "o/r", "xyz1234"]],
    ["a sha longer than 40", ["ci-wait", "o/r", "a".repeat(41)]],
    ["an unsafe base", ["ci-wait", "o/r", SHA, "--base", "a b"]],
  ])("exits 64 with usage on %s", async (_name, args) => {
    const result = await titanGh(args);

    expect(result.code).toBe(64);
    expect(result.out).toEqual([]);
    expect(result.err[0]).toMatch(/^usage: titan-gh ci-wait/);
  });
});
