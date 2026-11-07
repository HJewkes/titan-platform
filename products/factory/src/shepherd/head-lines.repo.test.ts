import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codewatchReader } from "./codewatch-questions.js";
import { cacheHeadLines } from "./head-lines.js";
import { hostCarryPorts } from "./carry-cache-adapter.js";
import { systemGit, type Git } from "./tree-carry.js";

const REPO = "acme/widgets";
const FIVE_LINES = "one\ntwo\nthree\nfour\nfive\n";

let root: string;
let origin: string;
let stateDir: string;
let head: string;

/** Counts the fetches the reader runs, passing every call through to real git. */
function countingGit(): { git: Git; fetches: () => number } {
  let fetches = 0;
  const git: Git = (gitDir, args, signal) => {
    if (args[0] === "fetch") fetches++;
    return systemGit(gitDir, args, signal);
  };
  return { git, fetches: () => fetches };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "head-lines-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  seedRepo(origin, {});
  gitIn(origin)("config", "uploadpack.allowAnySHA1InWant", "true");
  [head = ""] = withHistory(origin, [{ files: { "x.ts": FIVE_LINES }, message: "add x.ts" }]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cacheHeadLines", { timeout: 30_000 }, () => {
  it("fetches a head the cache lacks and reads its file lines", async () => {
    const counting = countingGit();
    const lines = await cacheHeadLines({ stateDir, remote: () => origin, git: counting.git })({ repo: REPO, head });

    expect(lines.lines("x.ts")).toEqual(["one", "two", "three", "four", "five"]);
    expect(counting.fetches()).toBe(1);
  });

  it("cacheHeadLines reads a head through the ports it is given", async () => {
    const counting = countingGit();
    const ports = { ...hostCarryPorts, git: counting.git, stateDir: () => stateDir };

    const lines = await cacheHeadLines({ ports, remote: () => origin })({ repo: REPO, head });

    expect(lines.lines("x.ts")).toHaveLength(5);
    expect(counting.fetches()).toBe(1);
  });

  it("runs no fetch for a head already in the cache", async () => {
    await cacheHeadLines({ stateDir, remote: () => origin })({ repo: REPO, head });
    const counting = countingGit();

    const lines = await cacheHeadLines({ stateDir, remote: () => origin, git: counting.git })({ repo: REPO, head });

    expect(lines.lines("x.ts")).toHaveLength(5);
    expect(counting.fetches()).toBe(0);
  });

  it("rejects a head the origin does not hold, and the reader then keeps no questions", async () => {
    const headLines = cacheHeadLines({ stateDir, remote: () => origin });
    const unknown = { repo: REPO, head: "e".repeat(40) };
    const read = codewatchReader(async () => ({ schema: "codewatch-pr-report@1", questions: ["x.ts:1 is this right?"] }), [REPO], headLines);

    await expect(headLines(unknown)).rejects.toThrow();
    expect((await read(unknown))?.evidence).toMatchObject({ found: true, questions: 0, warning: expect.stringMatching(/^codewatch head eeeeeeeeeeee unreadable/) });
  });

  it("drops a question past the end of a real head file and keeps one inside it", async () => {
    const questions = ["x.ts:3-40 whole file?", "x.ts:2-5 the rest?"];
    const read = codewatchReader(async () => ({ schema: "codewatch-pr-report@1", questions }), [REPO], cacheHeadLines({ stateDir, remote: () => origin }));

    const result = await read({ repo: REPO, head });

    expect(result?.questions).toEqual(["x.ts:2-5 the rest?"]);
    expect(result?.evidence.anchorDrops).toEqual(["head/x.ts#L3-L40: past EOF (5 lines)"]);
  });
});
