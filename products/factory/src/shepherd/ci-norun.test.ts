import { fakeGitHub, fakeSha, githubPort, successRun, type GitHubPort, type PullRequest } from "@titan-design/github";
import type { CiSnapshot } from "../workflows/land-ci.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { NO_RUN_GRACE_MS, noRunVerdict, noRunWake, skipTokenIn, type NoRunWatch } from "./ci-norun.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const H2 = fakeSha("head2");
const TEN_MINUTES = 10 * 60_000;
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A PR at H1 that GitHub started no CI run for; the woken fixer pushes H2, which runs green. */
function noRunWorld(pr: Partial<PullRequest>, message = "Add a feature") {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, ...pr });
  fake.commits.set(H1, { sha: H1, parents: [], message });
  fake.onGetPr = (live) => {
    if (live.headSha !== H2) return;
    live.mergeableState = "clean";
    fake.setRuns(H2, [successRun("validate", 1), successRun("dag-check", 2)]);
  };
  const wakes: { request: WakeRequest; at: number }[] = [];
  let clock = 0;
  const phases: ShepherdPhases = {
    wake: async (_ctx, request) => (wakes.push({ request, at: clock }), fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
    review: async () => ({ kind: "none" }),
  };
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { wakes };
}

describe("a PR head GitHub started no CI run for", () => {
  it("opens the conflict fix round within 10 minutes when the head conflicts with its base", async () => {
    const { wakes } = noRunWorld({ mergeableState: "dirty" });

    await vi.waitFor(() => expect(wakes).not.toHaveLength(0), { timeout: 4_000 });

    expect(wakes[0]!.request).toMatchObject({ kind: "conflict", headSha: H1 });
    expect(wakes[0]!.at).toBeLessThanOrEqual(TEN_MINUTES);
  });

  it("opens a fix round asking for a fresh commit within 10 minutes when the head message carries a skip token", async () => {
    const { wakes } = noRunWorld({ mergeableState: "blocked" }, "Add a feature\n\n[skip ci]");

    await vi.waitFor(() => expect(wakes).not.toHaveLength(0), { timeout: 4_000 });

    expect(wakes[0]!.request).toMatchObject({ kind: "ci-red", headSha: H1 });
    expect(JSON.stringify(wakes[0]!.request.payload)).toContain("[skip ci]");
    expect(wakes[0]!.at).toBeLessThanOrEqual(TEN_MINUTES);
  });
});

/** A pending read at H1 waiting on a check never started, probed once the grace has passed. */
async function probe(mergeableState: string, setup: (port: GitHubPort, fake: ReturnType<typeof fakeGitHub>) => GitHubPort = (port) => port, pending: Partial<CiSnapshot> = {}) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeableState });
  fake.commits.set(H1, { sha: H1, parents: [], message: "Add a feature [skip ci]" });
  const port = setup(githubPort(fake.wire), fake);
  const read: CiSnapshot = { verdict: "pending", headSha: H1, mergeableState, waitingOn: ["dag-check"], ...pending };
  const watch: NoRunWatch = {};
  const input = { repo: REPO, pr: 1, contexts: ["validate", "dag-check"], strict: true };
  await noRunVerdict(port, input, read, 0, watch);
  return noRunVerdict(port, input, read, NO_RUN_GRACE_MS, watch);
}

describe("noRunVerdict keeps waiting as before", () => {
  it("while GitHub has not settled whether a skip-free head conflicts", async () => {
    expect(await probe("unknown", (port, fake) => (fake.commits.set(H1, { sha: H1, parents: [] }), port))).toBeUndefined();
  });

  it("when the commit read fails", async () => {
    expect(await probe("blocked", (port) => ({ ...port, getCommit: async () => Promise.reject(new Error("502")) }))).toBeUndefined();
  });

  it("when the check-run read fails", async () => {
    expect(await probe("dirty", (port, fake) => ((fake.readFaults.listCheckRuns = [new Error("502")]), port))).toBeUndefined();
  });

  it("when Actions started a run at the head", async () => {
    expect(await probe("dirty", (port, fake) => (fake.setRuns(H1, [successRun("validate", 1)]), port))).toBeUndefined();
  });

  it("on a backlog read, whose every check already has a run", async () => {
    expect(await probe("dirty", undefined, { backlog: true })).toBeUndefined();
  });

  it("before the grace has passed", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1, mergeableState: "dirty" });
    const read: CiSnapshot = { verdict: "pending", headSha: H1, mergeableState: "dirty" };

    expect(await noRunVerdict(githubPort(fake.wire), { repo: REPO, pr: 1, contexts: [], strict: true }, read, 0, {})).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });
});

describe("noRunVerdict past the grace", () => {
  it("reads a conflicting head as not-mergeable", async () => {
    expect(await probe("dirty")).toMatchObject({ verdict: "not-mergeable", mergeableState: "dirty" });
  });

  it("reads a skip token as red, naming it", async () => {
    expect(await probe("blocked")).toMatchObject({ verdict: "red", failing: [{ name: "no CI run: head commit message carries [skip ci]", workflowRunId: null }] });
  });
});

describe("skipTokenIn", () => {
  it.each([
    ["Fix it\n\n[skip ci]", "[skip ci]"],
    ["[CI SKIP] docs", "[ci skip]"],
    ["Fix [no ci]", "[no ci]"],
    ["Fix [skip actions]", "[skip actions]"],
    ["Fix [actions skip]", "[actions skip]"],
    ["Fix\n\nskip-checks: true", "skip-checks: true"],
  ])("finds the token GitHub honours in %j", (message, token) => {
    expect(skipTokenIn(message)).toBe(token);
  });

  it.each(["Skip the CI cache when cold", "skip-checks: false", "[skip]"])("finds none in %j", (message) => {
    expect(skipTokenIn(message)).toBeUndefined();
  });
});

describe("noRunWake", () => {
  it("asks for a fresh commit and names the token, not a failing job", () => {
    const wake = noRunWake(H1, { failing: [{ name: "no CI run: head commit message carries [skip ci]", conclusion: null, url: "", workflowRunId: null }] });

    expect(wake?.reason).toContain("fresh commit");
    expect(wake?.reason).toContain(H1);
    expect(wake?.payload).toContain("[skip ci]");
  });

  it("is absent for an ordinary red", () => {
    expect(noRunWake(H1, { failing: [{ name: "validate", conclusion: "failure", url: "", workflowRunId: 1 }] })).toBeUndefined();
  });
});
