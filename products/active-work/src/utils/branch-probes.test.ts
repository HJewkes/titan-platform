import { afterEach, describe, expect, it } from "vitest";
import { resetRunners, setGitRunner } from "./git-gh.js";
import {
  isBranchPresent,
  readAheadBehind,
  readLastCommitIso,
  summarizeChecks,
} from "./branch-probes.js";

type Reply = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Reply => ({ code: 0, stdout, stderr: "" });
const fail: Reply = { code: 1, stdout: "", stderr: "" };

function stubGit(handler: (args: string[]) => Reply | Error): void {
  setGitRunner(async (_cmd: string, args: string[]) => {
    const r = handler(args);
    if (r instanceof Error) throw r;
    return r;
  });
}

afterEach(() => resetRunners());

describe("summarizeChecks", () => {
  it("returns undefined for an empty rollup", () => {
    expect(summarizeChecks([])).toBeUndefined();
  });
  it("reports pass when every check succeeded", () => {
    expect(
      summarizeChecks([{ conclusion: "SUCCESS" }, { state: "success" }])
    ).toBe("pass (2/2)");
  });
  it("reports fail ahead of pending", () => {
    expect(
      summarizeChecks([{ conclusion: "FAILURE" }, { state: "PENDING" }])
    ).toBe("fail (1/2)");
  });
  it("reports pending when none failed but some are unfinished", () => {
    expect(summarizeChecks([{ conclusion: "SUCCESS" }, {}])).toBe(
      "pending (1/2)"
    );
  });
});

describe("isBranchPresent", () => {
  it("is true when rev-parse succeeds", async () => {
    stubGit(() => ok("abc"));
    expect(await isBranchPresent("/r", "b")).toBe(true);
  });
  it("is false when rev-parse fails or throws", async () => {
    stubGit(() => fail);
    expect(await isBranchPresent("/r", "b")).toBe(false);
    stubGit(() => new Error("boom"));
    expect(await isBranchPresent("/r", "b")).toBe(false);
  });
});

describe("readLastCommitIso", () => {
  it("returns the trimmed timestamp", async () => {
    stubGit(() => ok("2026-01-02T03:04:05+00:00\n"));
    expect(await readLastCommitIso("/r", "b")).toBe(
      "2026-01-02T03:04:05+00:00"
    );
  });
  it("returns null on failure or empty output", async () => {
    stubGit(() => fail);
    expect(await readLastCommitIso("/r", "b")).toBeNull();
    stubGit(() => ok("  \n"));
    expect(await readLastCommitIso("/r", "b")).toBeNull();
  });
});

describe("readAheadBehind", () => {
  it("reads counts against origin/main", async () => {
    stubGit((args) => (args.includes("rev-list") ? ok("2\t5\n") : ok("sha")));
    expect(await readAheadBehind("/r", "b")).toEqual({ ahead: 5, behind: 2 });
  });
  it("falls back to origin/master", async () => {
    stubGit((args) => {
      if (args.includes("refs/remotes/origin/main")) return fail;
      return args.includes("rev-list") ? ok("0 1") : ok("sha");
    });
    expect(await readAheadBehind("/r", "b")).toEqual({ ahead: 1, behind: 0 });
  });
  it("is unknown without a default base or on malformed output", async () => {
    stubGit(() => fail);
    expect(await readAheadBehind("/r", "b")).toEqual({
      ahead: null,
      behind: null,
    });
    stubGit((args) => (args.includes("rev-list") ? ok("x") : ok("sha")));
    expect(await readAheadBehind("/r", "b")).toEqual({
      ahead: null,
      behind: null,
    });
  });
});
