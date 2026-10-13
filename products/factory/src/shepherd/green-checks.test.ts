import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { greenCheckNames, greenChecksAt } from "./green-checks.js";

const REPO = "octo/demo";
const H = fakeSha("green-head");
const OTHER = fakeSha("green-other-head");

const at = (run: CheckRun): CheckRun => ({ ...run, headSha: run.headSha || H });

describe("greenCheckNames", () => {
  it("lists the successful checks at the head and omits a failed one", () => {
    const runs = [successRun("validate", 1), successRun("build", 2), successRun("lint", 3, undefined, "failure")].map(at);

    expect(greenCheckNames(runs, H)).toEqual(["build", "validate"]);
  });

  it("ignores a success at another sha and one from a non-Actions app", () => {
    const runs = [successRun("validate", 1), successRun("stale", 2, undefined, "success", undefined, OTHER), successRun("bot", 3, undefined, "success", 999)].map(at);

    expect(greenCheckNames(runs, H)).toEqual(["validate"]);
  });

  it("judges each name by its newest run", () => {
    const runs = [successRun("validate", 1, "2026-01-01T00:00:00Z"), successRun("validate", 3, "2026-01-02T00:00:00Z", "failure"), successRun("build", 2)].map(at);

    expect(greenCheckNames(runs, H)).toEqual(["build"]);
  });

  it("does not count a skipped, neutral or unfinished run as green", () => {
    const pending = { ...successRun("e2e", 4), status: "in_progress", conclusion: null };
    const runs = [successRun("docs", 1, undefined, "skipped"), successRun("perf", 2, undefined, "neutral"), successRun("build", 3), pending].map(at);

    expect(greenCheckNames(runs, H)).toEqual(["build"]);
  });
});

describe("greenChecksAt", () => {
  it("reads the green checks at the head through the port", async () => {
    const fake = fakeGitHub();
    fake.setRuns(H, [successRun("validate", 1), successRun("lint", 2, undefined, "failure")]);

    expect(await greenChecksAt(githubPort(fake.wire), REPO, H)).toEqual(["validate"]);
  });

  it("answers no checks when the check-runs read fails", async () => {
    const fake = fakeGitHub();
    fake.setRuns(H, [successRun("validate", 1)]);
    fake.readFaults.listCheckRuns = [new Error("rate limited")];

    expect(await greenChecksAt(githubPort(fake.wire), REPO, H)).toEqual([]);
  });

  it("answers no checks when there is no port", async () => {
    expect(await greenChecksAt(undefined, REPO, H)).toEqual([]);
  });
});
