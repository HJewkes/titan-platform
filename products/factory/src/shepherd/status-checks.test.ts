import { fakeGitHub, fakeSha, githubPort, successRun, type CommitStatus } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { H1, REPO } from "../test-support/land.js";
import { readCi } from "../workflows/land-ci.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS } from "./post-merge.js";
import { configuredStatusContexts, withStatusChecks } from "./status-checks.js";

const GATE = "local-gate";
const MERGE = fakeSha("status-merge");
const status = (state: string, context = GATE): CommitStatus => ({ context, state, targetUrl: "https://ci.example/run/1", description: null, createdAt: null, updatedAt: null });
const configured = configuredStatusContexts(() => ({ [REPO.toUpperCase()]: { statusContexts: [GATE] } }));
const unconfigured = configuredStatusContexts(() => ({ "octo/other": { statusContexts: [GATE] } }));

function world(statuses: CommitStatus[], contextsFor = configured) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeableState: "clean", behind: false });
  fake.statuses.set(H1, statuses);
  fake.statuses.set(MERGE, statuses);
  return { fake, port: withStatusChecks(githubPort(fake.wire), contextsFor) };
}

/** Two polls of an open repo, as ci-wait makes them: the second read of the same run set settles it. */
async function landVerdict(statuses: CommitStatus[], contextsFor = configured, contexts: string[] = []) {
  const { port } = world(statuses, contextsFor);
  const options = { openSeen: {} };
  const ciInput = { repo: REPO, pr: 1, contexts, strict: false };
  await readCi(port, ciInput, undefined, options);
  return readCi(port, ciInput, undefined, options);
}

function mainVerdict(statuses: CommitStatus[], contextsFor = configured) {
  const { port } = world(statuses, contextsFor);
  let clock = 0;
  const timing = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
  return readMainCi(port, { repo: REPO, mergeSha: MERGE, after: [] }, timing, new AbortController().signal);
}

describe("land ci-wait on a repo whose CI posts a configured commit status", () => {
  it("lands on a success status with no Actions run at all", async () => {
    expect((await landVerdict([status("success")])).verdict).toBe("green");
  });

  it("holds on a pending status, naming the context", async () => {
    expect(await landVerdict([status("pending")])).toMatchObject({ verdict: "pending", waitingOn: [GATE] });
  });

  it.each(["failure", "error"])("reads a %s status as red", async (state) => {
    expect(await landVerdict([status(state)])).toMatchObject({ verdict: "red", failing: [{ name: GATE, conclusion: state, workflowRunId: null }] });
  });

  it("holds while the configured status has not been posted, even beside a green Actions run", async () => {
    const { fake, port } = world([status("success", "unrelated")]);
    fake.setRuns(H1, [successRun("lint", 1)]);
    const options = { openSeen: {} };
    const ciInput = { repo: REPO, pr: 1, contexts: [], strict: false };
    await readCi(port, ciInput, undefined, options);

    expect(await readCi(port, ciInput, undefined, options)).toMatchObject({ verdict: "pending", waitingOn: [GATE] });
  });

  it("satisfies a base that requires the context by name", async () => {
    expect((await landVerdict([status("success")], configured, [GATE])).verdict).toBe("green");
  });

  it("ignores the status on a repo with no configured contexts, which waits on Actions as before", async () => {
    expect(await landVerdict([status("success")], unconfigured)).toMatchObject({ verdict: "pending", waitingOn: ["any GitHub Actions check-run"] });
  });
});

describe("readMainCi on a repo whose CI posts a configured commit status", () => {
  it("returns green from a success status instead of none", async () => {
    expect((await mainVerdict([status("success")])).verdict).toBe("green");
  });

  it("returns red from a failure status", async () => {
    expect((await mainVerdict([status("failure")])).verdict).toBe("red");
  });

  it("returns none for an unconfigured repo whose only CI is a status", async () => {
    expect((await mainVerdict([status("success")], unconfigured)).verdict).toBe("none");
  });
});

describe("configuredStatusContexts", () => {
  it("matches repo keys in any case and reads nothing for an absent config", () => {
    expect([configured(REPO), configuredStatusContexts(() => undefined)(REPO)]).toEqual([[GATE], []]);
  });
});
