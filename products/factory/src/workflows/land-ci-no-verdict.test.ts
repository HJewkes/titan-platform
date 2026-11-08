import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { readCi, requiredChecksPass } from "./land-ci.js";
import { portReads } from "./pr-snapshot.js";
import { REPO } from "../test-support/land.js";

const HEAD = fakeSha("head1");
const REQUIRED = ["dag-check", "hub-compose", "validate"];
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T00:05:00Z";

const job = (name: string, id: number, workflowRunId: number, startedAt: string, conclusion: string | null): CheckRun => ({
  ...successRun(name, id, startedAt, conclusion ?? "success"),
  workflowRunId,
  ...(conclusion === null && { status: "in_progress", conclusion: null }),
});

/** The fix-proof workflow ran twice at the head: the first run's mutants job failed, and a later run skipped every job. */
const duplicateFixProof = [
  job("fix-proof-mutants", 31, 3001, T0, "failure"),
  job("fix-proof", 32, 3001, T0, "success"),
  ...["fix-proof-base", "fix-proof-head", "fix-proof-mutants", "fix-proof"].map((name, i) => job(name, 41 + i, 4001, T1, "skipped")),
];

async function read(runs: CheckRun[]) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, runs);
  const port = githubPort(fake.wire);
  const ci = await readCi(port, { repo: REPO, pr: 1, contexts: REQUIRED, strict: false });
  return { ci, passes: await requiredChecksPass({ repo: REPO, contexts: REQUIRED }, HEAD, portReads(port)) };
}

describe("ci-wait never reads a skipped run, or a failure a newer run left unjudged, as red", () => {
  it("tp#2576: the required runs still in progress beside a skipped duplicate run read pending, not red", async () => {
    const live = [job("dag-check", 11, 2001, T0, null), job("validate", 12, 2001, T0, null), job("hub-compose", 13, 2001, T0, "success")];

    const { ci } = await read([...live, ...duplicateFixProof]);

    expect(ci.verdict).toBe("pending");
    expect(ci.failing).toBeUndefined();
  });

  it("tp#2622: every required check passed and the failed mutants job was replaced by a skipped run, so no fixer is woken; the skip settles it (TP-4993)", async () => {
    const required = REQUIRED.map((name, i) => job(name, 11 + i, 2001, T0, "success"));

    const { ci, passes } = await read([...required, ...duplicateFixProof]);

    expect(ci.verdict).toBe("green");
    expect(ci.failing).toBeUndefined();
    expect(passes).toBe(true);
  });

  it("a required check whose only run was skipped is waited on, not red", async () => {
    const { ci } = await read([job("dag-check", 11, 2001, T0, "success"), job("hub-compose", 12, 2001, T0, "success"), job("validate", 13, 2001, T0, "skipped")]);

    expect(ci.verdict).toBe("pending");
    expect(ci.waitingOn).toEqual(["validate"]);
  });

  it("a failed check whose newer workflow run is still running is waited on, not red", async () => {
    const { ci } = await read([job("dag-check", 11, 2001, T0, "success"), job("hub-compose", 12, 2001, T0, "success"), job("validate", 13, 2001, T0, "failure"), job("validate", 23, 2002, T1, null)]);

    expect(ci.verdict).toBe("pending");
    expect(ci.failing).toBeUndefined();
  });

  it("a failure that is the newest run of its check stays red, beside a skipped duplicate run", async () => {
    const required = [job("dag-check", 11, 2001, T0, "success"), job("hub-compose", 12, 2001, T0, "success"), job("validate", 13, 2001, T0, "failure")];

    const { ci } = await read([...required, ...duplicateFixProof.slice(2)]);

    expect(ci.verdict).toBe("red");
    expect(ci.failing?.map((check) => check.name)).toEqual(["validate"]);
  });
});
