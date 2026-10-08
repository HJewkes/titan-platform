import { fakeGitHub, fakeSha, githubPort, successRun, FakeHttpError, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { REPO } from "../test-support/land.js";
import { readBaseRequiredChecks } from "../required-checks.js";
import { greenAfterRed } from "./freeze.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS } from "./post-merge.js";

const MERGE = fakeSha("merge");
const RED = fakeSha("red");
const OTHER_APP = 999;
const PINNED_APP = 777;

function world(options: { required?: string[]; classic?: string[]; pins?: Record<string, number[]> } = {}): FakeGitHub {
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: fakeSha("head"), baseRef: "main" });
  fake.rules = { contexts: options.required ?? [], strict: false, ...(options.pins && { pins: options.pins }) };
  fake.classicRules = { contexts: options.classic ?? [], strict: false };
  return fake;
}

function readMain(fake: FakeGitHub) {
  let clock = 0;
  const timing = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
  return readMainCi(githubPort(fake.wire), { repo: REPO, pr: 1, mergeSha: MERGE, after: [] }, timing, new AbortController().signal);
}

const failed = (name: string, id: number, app?: number) => successRun(name, id, undefined, "failure", app);

describe("main CI judged by the base branch's required contexts", () => {
  it("is green with a warning when every required context passes and only release is red", async () => {
    const fake = world({ required: ["validate", "dag-check"] });
    fake.setRuns(MERGE, [successRun("validate", 1), successRun("dag-check", 2), failed("release", 3)]);

    const result = await readMain(fake);

    expect(result).toMatchObject({ verdict: "green", warning: "not required, so not blocking: release" });
  });

  it("is red when a required context is red", async () => {
    const fake = world({ required: ["validate", "dag-check"] });
    fake.setRuns(MERGE, [failed("validate", 1), successRun("dag-check", 2), successRun("release", 3)]);

    expect(await readMain(fake)).toMatchObject({ verdict: "red", detail: "failed: validate" });
  });

  it("keeps the all-checks rule for a repo with no rules", async () => {
    const fake = world();
    fake.setRuns(MERGE, [successRun("validate", 1), failed("release", 2)]);

    expect(await readMain(fake)).toMatchObject({ verdict: "red", detail: "failed: release" });
  });

  it("keeps the all-checks rule when the rules cannot be read", async () => {
    const fake = world({ required: ["validate"] });
    fake.wire.getBranchRules = async () => Promise.reject(new FakeHttpError(502, "bad gateway"));
    fake.setRuns(MERGE, [successRun("validate", 1), failed("release", 2)]);

    expect(await readMain(fake)).toMatchObject({ verdict: "red" });
  });

  it("keeps the all-checks rule when classic protection cannot be read", async () => {
    const fake = world();
    fake.wire.getClassicRequiredChecks = async () => Promise.reject(new FakeHttpError(502, "bad gateway"));
    fake.setRuns(MERGE, [successRun("validate", 1), failed("release", 2)]);

    expect(await readMain(fake)).toMatchObject({ verdict: "red" });
  });

  it("judges by classic protection's list when no ruleset requires anything", async () => {
    const fake = world({ classic: ["validate"] });
    fake.setRuns(MERGE, [successRun("validate", 1), failed("release", 2)]);

    expect(await readMain(fake)).toMatchObject({ verdict: "green", warning: "not required, so not blocking: release" });
  });

  it("does not count a required context satisfied only by another app's run", async () => {
    const fake = world({ required: ["validate"] });
    fake.setRuns(MERGE, [successRun("validate", 1, undefined, "success", OTHER_APP)]);

    expect((await readMain(fake)).verdict).toBe("none");
  });

  it("does not let an Actions run satisfy a context pinned to another app, nor fail it", async () => {
    const fake = world({ required: ["validate"], pins: { validate: [PINNED_APP] } });
    fake.setRuns(MERGE, [failed("validate", 1)]);

    expect((await readMain(fake)).verdict).toBe("none");
  });

  it("judges a pinned context by the pinned app's run", async () => {
    const fake = world({ required: ["validate"], pins: { validate: [PINNED_APP] } });
    fake.setRuns(MERGE, [successRun("validate", 1, undefined, "success", PINNED_APP), failed("validate", 2)]);

    expect((await readMain(fake)).verdict).toBe("green");
  });

  it("waits on a required context with no run yet", async () => {
    const fake = world({ required: ["validate", "dag-check"] });
    fake.setRuns(MERGE, [successRun("validate", 1)]);

    expect((await readMain(fake)).verdict).toBe("none");
  });
});

describe("a freeze recheck judged by the required contexts", () => {
  const red = { redSha: RED, cancelOnly: false };

  it("thaws on a head green on the required contexts while release is still red", async () => {
    const fake = world({ required: ["validate"] });
    fake.setRuns(MERGE, [successRun("validate", 1), failed("release", 2)]);

    expect(await greenAfterRed(githubPort(fake.wire), REPO, MERGE, red, "main")).toBe(true);
  });

  it("stays frozen while a required context is red", async () => {
    const fake = world({ required: ["validate"] });
    fake.setRuns(MERGE, [failed("validate", 1)]);

    expect(await greenAfterRed(githubPort(fake.wire), REPO, MERGE, red, "main")).toBe(false);
  });

  it("keeps the all-checks rule for a repo with no rules", async () => {
    const fake = world();
    fake.setRuns(RED, [failed("release", 1)]);
    fake.setRuns(MERGE, [successRun("validate", 2), failed("release", 3)]);

    expect(await greenAfterRed(githubPort(fake.wire), REPO, MERGE, red, "main")).toBe(false);
  });
});

describe("readBaseRequiredChecks", () => {
  it("reads classic protection only when the rulesets require nothing", async () => {
    const fake = world({ required: ["from-ruleset"], classic: ["from-classic"] });

    expect(await readBaseRequiredChecks(githubPort(fake.wire), REPO, "main")).toMatchObject({ readable: true, checks: { contexts: ["from-ruleset"] } });
    fake.rules = { contexts: [], strict: false };
    expect(await readBaseRequiredChecks(githubPort(fake.wire), REPO, "main")).toMatchObject({ readable: true, checks: { contexts: ["from-classic"] } });
  });
});
