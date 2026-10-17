import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { ciCheckRows, ciChecksAt } from "./green-checks.js";
import { REVIEW_CHECK_NAME } from "./publish-review.js";

const REPO = "octo/demo";
const H = fakeSha("green-head");
const OTHER = fakeSha("green-other-head");

const at = (run: CheckRun): CheckRun => ({ ...run, headSha: run.headSha || H });
const row = (name: string, conclusion: string | null, required = false) => ({ name, status: conclusion === null ? "in_progress" : "completed", conclusion, required });

describe("ciCheckRows", () => {
  it("rows carry the newest Actions run per name and mark required contexts", () => {
    const runs = [successRun("validate", 1, "2026-01-01T00:00:00Z"), successRun("validate", 3, "2026-01-02T00:00:00Z", "failure"), successRun("build", 2)].map(at);

    expect(ciCheckRows(runs, H, ["validate"])).toEqual([row("build", "success"), row("validate", "failure", true)]);
  });

  it("ignores a run at another sha and a non-Actions run that no required context names", () => {
    const runs = [successRun("validate", 1), successRun("stale", 2, undefined, "success", undefined, OTHER), successRun("bot", 3, undefined, "success", 999)].map(at);

    expect(ciCheckRows(runs, H, [])).toEqual([row("validate", "success")]);
  });

  it("keeps a required context another app posts, and lists a required context with no run as missing", () => {
    const runs = [successRun("deploy-preview", 1, undefined, "success", 999)].map(at);

    expect(ciCheckRows(runs, H, ["deploy-preview", "validate"])).toEqual([row("deploy-preview", "success", true), { name: "validate", status: "missing", conclusion: null, required: true }]);
  });

  it("never lists shepherd/review, the review being asked for", () => {
    const runs = [successRun(REVIEW_CHECK_NAME, 1, undefined, "success", 999), successRun("validate", 2)].map(at);

    expect(ciCheckRows(runs, H, [REVIEW_CHECK_NAME, "validate"])).toEqual([row("validate", "success", true)]);
  });
});

describe("ciChecksAt", () => {
  const world = () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: H });
    fake.rules = { contexts: ["validate"], strict: false };
    fake.setRuns(H, [successRun("validate", 1), { ...successRun("lint", 2), status: "in_progress", conclusion: null }]);
    return { fake, pr: pr.number };
  };

  it("reads the PR's base rules and the head's check-runs through the port", async () => {
    const { fake, pr } = world();

    expect(await ciChecksAt(githubPort(fake.wire), REPO, pr, H)).toEqual([row("lint", null), row("validate", "success", true)]);
  });

  it.each(["getBranchRules", "listCheckRuns"] as const)("an unreadable %s answers undefined so the brief falls back", async (read) => {
    const { fake, pr } = world();
    fake.readFaults[read] = [new Error("rate limited")];

    expect(await ciChecksAt(githubPort(fake.wire), REPO, pr, H)).toBeUndefined();
  });

  it("an unreadable PR answers undefined so the brief falls back", async () => {
    const { fake } = world();

    expect(await ciChecksAt(githubPort(fake.wire), REPO, 9999, H)).toBeUndefined();
  });
});
