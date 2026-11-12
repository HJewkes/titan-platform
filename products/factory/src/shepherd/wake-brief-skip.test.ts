import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { describeWake } from "./wake-brief.js";

const REPO = "octo/demo";
const H1 = fakeSha("head-1");

const run = (name: string, id: number, workflowRunId: number, startedAt: string, conclusion: string | null): CheckRun => ({
  ...successRun(name, id, startedAt, conclusion ?? "success"),
  headSha: H1,
  workflowRunId,
  ...(conclusion === null && { status: "in_progress", conclusion: null, completedAt: null }),
});

async function ciRedWake(runs: CheckRun[]) {
  const fake = fakeGitHub({ repo: REPO });
  const pr = fake.addPr({ headSha: H1 });
  fake.setRuns(H1, runs);
  const logged: number[] = [];
  const port = { ...githubPort(fake.wire), jobLogTail: async (_repo: string, id: number) => (logged.push(id), "mutation spec refused") };
  const wake = await describeWake(port, { kind: "ci-red", repo: REPO, pr: pr.number, headSha: H1, payload: null }, pr);
  return { wake, logged };
}

describe("a ci-red wake over a failure that a newer skip hides (tp#3329)", () => {
  it("hands the fixer the push run's failed mutants job, though the PR-edit run's skip is the newest run", async () => {
    const { wake, logged } = await ciRedWake([run("fix-proof-mutants", 32, 3001, "2026-01-01T12:03:58Z", "failure"), run("fix-proof-mutants", 44, 4001, "2026-01-01T12:04:24Z", "skipped")]);

    expect(wake.reason).toContain("1 failing check run(s)");
    expect(wake.payload).toContain("mutation spec refused");
    expect(logged).toEqual([32]);
  });

  it("hands over no run still going behind a newer skip, since it has not failed", async () => {
    const { wake, logged } = await ciRedWake([run("fix-proof-mutants", 32, 3001, "2026-01-01T12:03:58Z", null), run("fix-proof-mutants", 44, 4001, "2026-01-01T12:04:24Z", "skipped")]);

    expect(wake.payload).toContain("No failing check run was found at this head.");
    expect(logged).toEqual([]);
  });

  it("hands over nothing while a rerun is still going between the failure and the newer skip", async () => {
    const runs = [run("fix-proof-mutants", 32, 3001, "2026-01-01T12:03:58Z", "failure"), run("fix-proof-mutants", 52, 5001, "2026-01-01T12:04:10Z", null), run("fix-proof-mutants", 44, 4001, "2026-01-01T12:04:24Z", "skipped")];

    const { wake, logged } = await ciRedWake(runs);

    expect(wake.payload).toContain("No failing check run was found at this head.");
    expect(logged).toEqual([]);
  });

  it("finds no failing run when the skip follows a run that passed", async () => {
    const { wake, logged } = await ciRedWake([run("fix-proof-mutants", 32, 3001, "2026-01-01T12:03:58Z", "success"), run("fix-proof-mutants", 44, 4001, "2026-01-01T12:04:24Z", "skipped")]);

    expect(wake.payload).toContain("No failing check run was found at this head.");
    expect(logged).toEqual([]);
  });
});
