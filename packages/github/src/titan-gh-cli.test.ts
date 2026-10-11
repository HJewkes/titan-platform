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

async function titanGhPr(args: string[]) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: SHA });
  fake.setRuns(SHA, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.squashSources.set(1, { title: "Add the widget", body: "Adds the widget.", commits: [] });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTitanGh(args, { port: githubPort(fake.wire), out: (line) => out.push(line), err: (line) => err.push(line), now: () => 0, sleep: async () => {} });
  return { code, out, err, fake };
}

describe("titan-gh pr verbs", () => {
  it("prints pr-status as one JSON object with --json", async () => {
    const result = await titanGhPr(["pr-status", "o/r#1", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ repo: "o/r", number: 1, state: "open", ready: true, checks: [{ name: "validate", state: "success" }, { name: "dag-check", state: "success" }] });
  });

  it("dispatches pr-context", async () => {
    const result = await titanGhPr(["pr-context", "o/r#1"]);

    expect(result.code).toBe(0);
    expect(result.out.join("\n").split("\n")[0]).toBe("o/r#1 Add the widget");
  });

  it("names the pr verbs and an example in the usage for an unknown verb", async () => {
    const result = await titanGhPr(["pr-merge", "o/r#1"]);

    expect(result.code).toBe(64);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("titan-gh pr-status <owner/repo#N> [--json]");
    expect(result.err.join("\n")).toContain("example: titan-gh pr-status");
  });

  it.each(["o/r", "o/r#0", "o/r#x", "o#1", "o/r/x#1", "https://github.com/o/r/pull/1"])("exits 64 before any GitHub read for the malformed ref %s", async (ref) => {
    const result = await titanGhPr(["pr-status", ref]);

    expect(result.code).toBe(64);
    expect(result.err[0]).toMatch(/^usage: titan-gh/);
    expect(result.fake.calls).toEqual([]);
  });
});

async function titanGhPremerge(args: string[], setup: (fake: ReturnType<typeof fakeGitHub>) => void = () => {}) {
  const fake = fakeGitHub();
  fake.rules = { contexts: ["validate"], strict: false };
  fake.addPr({ headSha: SHA, behindBy: 0 });
  fake.setRuns(SHA, [successRun("validate", 1)]);
  setup(fake);
  const out: string[] = [];
  const err: string[] = [];
  const clones: string[] = [];
  const mergeTree = (clone: string) => async () => (clones.push(clone), fakeSha(`tree:${SHA}`));
  const code = await runTitanGh(args, { port: githubPort(fake.wire), out: (line) => out.push(line), err: (line) => err.push(line), now: () => 0, sleep: async () => {}, mergeTree });
  return { code, out, err, fake, clones };
}

describe("titan-gh premerge", () => {
  const REVIEWED = fakeSha("reviewed");
  const BASE_PARENT = fakeSha("base-parent");

  it("prints the OK line and exits 0 for a ready PR", async () => {
    expect(await titanGhPremerge(["premerge", "o/r#1", SHA, "--approved-head", SHA])).toMatchObject({ code: 0, out: [`OK o/r#1 head=${SHA} base=main req=[validate] strict=false behind=0`], err: [] });
  });

  it("prints the FAIL line and exits 1 when a required check is red", async () => {
    const result = await titanGhPremerge(["premerge", "o/r#1", SHA, "--approved-head", SHA], (fake) => fake.setRuns(SHA, [successRun("validate", 1, undefined, "failure")]));

    expect(result).toMatchObject({ code: 1, out: ["FAIL o/r#1: checks red: validate=failure"] });
  });

  it("prints one JSON object with --json", async () => {
    const result = await titanGhPremerge(["premerge", "o/r#1", SHA, "--approved-head", SHA, "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ repo: "o/r", number: 1, ok: true, reasons: [], head: SHA, base: "main", required: ["validate"], strict: false, behindBy: 0 });
  });

  it("proves a walked approval with git merge-tree in the --clone directory", async () => {
    const setup = (fake: ReturnType<typeof fakeGitHub>) => void fake.commits.set(SHA, { sha: SHA, parents: [REVIEWED, BASE_PARENT], tree: fakeSha(`tree:${SHA}`) });
    const result = await titanGhPremerge(["premerge", "o/r#1", SHA, "--approved-head", REVIEWED, "--clone", "/tmp/clone"], setup);

    expect(result).toMatchObject({ code: 0, clones: ["/tmp/clone"] });
  });

  it("fails a walked approval closed without --clone", async () => {
    const setup = (fake: ReturnType<typeof fakeGitHub>) => void fake.commits.set(SHA, { sha: SHA, parents: [REVIEWED, BASE_PARENT], tree: fakeSha(`tree:${SHA}`) });
    const result = await titanGhPremerge(["premerge", "o/r#1", SHA, "--approved-head", REVIEWED], setup);

    expect(result.code).toBe(1);
    expect(result.out[0]).toContain(`no merge-tree proof that head ${SHA} is reviewed ${REVIEWED}`);
  });

  it.each([
    ["no arguments", []],
    ["a missing approved head", [`o/r#1`, SHA]],
    ["an abbreviated head", ["o/r#1", SHA.slice(0, 7), "--approved-head", SHA]],
    ["an upper-case approved head", ["o/r#1", SHA, "--approved-head", SHA.toUpperCase()]],
    ["a malformed ref", ["o/r", SHA, "--approved-head", SHA]],
    ["an extra argument", ["o/r#1", SHA, "extra", "--approved-head", SHA]],
    ["an unknown flag", ["o/r#1", SHA, "--approved-head", SHA, "--force"]],
    ["a flag without a value", ["o/r#1", SHA, "--approved-head"]],
  ])("exits 2 with usage and no GitHub read on %s", async (_name, args) => {
    const result = await titanGhPremerge(["premerge", ...args]);

    expect(result).toMatchObject({ code: 2, out: [] });
    expect(result.err.join("\n")).toContain("titan-gh premerge <owner/repo#N> <sha> --approved-head <sha>");
    expect(result.fake.calls).toEqual([]);
  });
});
