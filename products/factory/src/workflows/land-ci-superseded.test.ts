import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { readCi } from "./land-ci.js";
import { REPO } from "../test-support/land.js";

const HEAD = fakeSha("head1");
const NAMES = ["validate", "dag-check", "hub-compose"];
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T00:05:00Z";

const cancelled = (name: string, id: number): CheckRun => ({ ...successRun(name, id, T0), conclusion: "cancelled" });
const queued = (name: string, id: number): CheckRun => ({ ...successRun(name, id, T1), status: "queued", conclusion: null });

async function read(runs: CheckRun[]) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, runs);
  return readCi(githubPort(fake.wire), { repo: REPO, pr: 1, contexts: NAMES, strict: false });
}

describe("ci-wait on a head whose older run was cancelled by a newer one", () => {
  it("reads green when the newer run of each check succeeded", async () => {
    const runs = NAMES.flatMap((name, i) => [cancelled(name, 10 + i), successRun(name, 20 + i, T1)]);

    expect((await read(runs)).verdict).toBe("green");
  });

  it("reads pending, not red, while the newer runs are still queued", async () => {
    const runs = NAMES.flatMap((name, i) => [cancelled(name, 10 + i), queued(name, 20 + i)]);

    const ci = await read(runs);

    expect(ci.verdict).toBe("pending");
    expect(ci.waitingOn).toEqual(NAMES);
  });

  it("stays red for a cancelled run that no newer run replaced", async () => {
    const ci = await read([cancelled("validate", 10), successRun("dag-check", 11), successRun("hub-compose", 12)]);

    expect(ci.verdict).toBe("red");
    expect(ci.failing?.map((check) => check.name)).toEqual(["validate"]);
  });

  it("stays red when the newer run failed", async () => {
    const runs = [cancelled("validate", 10), { ...successRun("validate", 20, T1), conclusion: "failure" }, successRun("dag-check", 11), successRun("hub-compose", 12)];

    expect((await read(runs)).verdict).toBe("red");
  });
});

describe("ci-wait on a head where concurrency cancelled one of two runs (td#894)", () => {
  const job = (name: string, id: number, workflowRunId: number, conclusion: string | null): CheckRun => ({
    ...successRun(name, id, T0, conclusion ?? "success"),
    workflowRunId,
    ...(conclusion === null && { status: "in_progress", conclusion: null }),
  });
  const cancelledRun = [job("build", 11, 2002, "cancelled"), job("check", 12, 2002, "failure")];

  it("reads pending, not red, while the other run is live, though the cancelled run's aggregate check failed", async () => {
    const ci = await read([...cancelledRun, job("build", 21, 1001, null), ...NAMES.map((name, i) => job(name, 30 + i, 1001, "success"))]);

    expect(ci.verdict).toBe("pending");
  });

  it("stays red when the other run fails too", async () => {
    const ci = await read([...cancelledRun, job("build", 21, 1001, "failure"), ...NAMES.map((name, i) => job(name, 30 + i, 1001, "success"))]);

    expect(ci.verdict).toBe("red");
    expect(ci.failing?.map((check) => check.name).sort()).toEqual(["build", "check"]);
  });

  it("stays red when no other run shares a job with the cancelled one", async () => {
    const ci = await read([...cancelledRun, ...NAMES.map((name, i) => job(name, 30 + i, 1001, "success"))]);

    expect(ci.verdict).toBe("red");
  });
});
