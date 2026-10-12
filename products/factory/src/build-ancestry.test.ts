import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cachedAncestry, gitAncestry, runningHolds, type AncestryProbe } from "./build-ancestry.js";
import { gitLine } from "./test-support/git-line.js";

const repo = gitLine();
const { older: OLDER, newer: NEWER } = repo;
const MISSING = "f".repeat(40);
afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

describe("whether the running build holds a target", () => {
  const probe = gitAncestry(repo.dir);

  it("holds an older commit it descends from, but not a newer one", async () => {
    expect(await runningHolds(probe, NEWER, OLDER)).toBe(true);
    expect(await runningHolds(probe, OLDER, NEWER)).toBe(false);
  });

  it("says why when git cannot find an object, rather than answering no", async () => {
    const holds = await runningHolds(probe, NEWER, MISSING);

    expect(holds).toMatchObject({ unknown: expect.stringContaining("git merge-base exited 128") });
  });

  it("reads a dirty build as its base commit and an unknown build as holding nothing", async () => {
    expect(await runningHolds(probe, `${NEWER}-dirty`, OLDER)).toBe(true);
    expect(await runningHolds(probe, "unknown", OLDER)).toBe(false);
  });

  it("reports a missing git binary as no answer", async () => {
    const noGit = gitAncestry(repo.dir, async () => undefined);

    expect(await noGit(OLDER, NEWER)).toEqual({ unknown: "git is not on PATH" });
  });
});

describe("the cached ancestry probe", () => {
  it("asks git once per pair for a definite answer, but again after a failure", async () => {
    const asked: string[] = [];
    let answer: Awaited<ReturnType<AncestryProbe>> = { unknown: "fetch pending" };
    const probe = cachedAncestry(async (ancestor) => (asked.push(ancestor), answer));

    await probe(OLDER, NEWER);
    answer = true;
    await probe(OLDER, NEWER);
    const third = await probe(OLDER, NEWER);

    expect(asked).toEqual([OLDER, OLDER]);
    expect(third).toBe(true);
  });
});
