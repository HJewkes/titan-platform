import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { TEST_BRIEF } from "../test-support/brief.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { freezeStoreRef } from "./freeze.js";
import { CLOSED_ELSEWHERE, LANDED_ELSEWHERE, endRunsGoneElsewhere } from "./gone-elsewhere.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { MAIN_GREEN } from "./post-merge.js";
import { shepherdPrWorkflow } from "./pr.js";
import { SHEPHERD_WORKFLOW } from "./services.js";
import { shepherdStoreRef } from "./store.js";

type Run = ReturnType<typeof successRun>;

const LATER = fakeSha("later-main");
const required = (id: number, conclusion?: string): Run[] => [successRun("validate", id, undefined, conclusion), successRun("dag-check", id + 1)];
const running = (id: number): Run[] => [{ ...successRun("validate", id), status: "in_progress", conclusion: null }, successRun("dag-check", id + 1)];

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A registered Shepherd run whose merge's main run was cancelled with nothing newer, so it waits on main-ci-timeout. */
async function timedOut() {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, required(1));
  const base = githubPort(fake.wire);
  const cancelledAtMerge = (sha: string) => sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 5, undefined, "cancelled"), successRun("dag-check", 6, undefined, "skipped")]);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (cancelledAtMerge(sha), base.checkRuns(repo, sha)) };
  let clock = 0;
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store, freeze: freezeStoreRef(() => clock), now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  await gateOpened(host, gateId(runId, "main-ci-timeout"));
  return { host, fake, store, runId, services: routes.shepherd! };
}

/** Main moved on to LATER, which contains the merge unless `mergeBase` says otherwise, with `runs` at it. */
function mainMovedTo(fake: FakeGitHub, runs: Run[], mergeBase?: string): void {
  const merge = fake.pr(1).mergeSha!;
  fake.refs.set("main", LATER);
  fake.compares.set(`${merge}...${LATER}`, { mergeBaseSha: mergeBase ?? merge, files: [] });
  fake.setRuns(LATER, runs);
}

const ackStep = (host: FactoryHost, runId: string) => Object.values(host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "main-ci-timeout");

describe("the gone sweep on a main-ci-timeout gate", () => {
  it("clears the gate once a later main commit containing the merge is green on every required context, and the run finishes", async () => {
    const { host, fake, store, runId, services } = await timedOut();
    mainMovedTo(fake, required(20));
    const cleared: string[] = [];

    await endRunsGoneElsewhere(host, services, { onMainGreen: ({ gateId: id }) => cleared.push(id) });
    await host.runtime.wait(runId);

    expect(cleared).toEqual([gateId(runId, "main-ci-timeout")]);
    expect(host.gates.get(gateId(runId, "main-ci-timeout"))?.status).toBe("cancelled");
    expect(host.runtime.status(runId)?.status).toBe("completed");
    const reason = String(ackStep(host, runId)?.data?.reason);
    expect(reason.startsWith(MAIN_GREEN)).toBe(true);
    expect(reason).toContain(`main commit ${LATER} on main of ${REPO} contains merge ${fake.pr(1).mergeSha}`);
    expect(reason).toContain("validate #20 success, dag-check #21 success");
    expect(store.get().eventsOf(runId).find((event) => event.kind === "gate-cancel")?.reason).toBe(reason);
  });

  it.each([
    ["red", () => required(20, "failure")],
    ["still running", () => running(20)],
  ])("keeps the gate while main is %s", async (_state, runs) => {
    const { host, fake, runId, services } = await timedOut();
    mainMovedTo(fake, runs());
    const cleared: string[] = [];

    await endRunsGoneElsewhere(host, services, { onMainGreen: ({ gateId: id }) => cleared.push(id) });

    expect(cleared).toEqual([]);
    expect(host.gates.get(gateId(runId, "main-ci-timeout"))?.status).toBe("pending");
  });

  it("keeps the gate when the green main commit does not contain the merge", async () => {
    const { host, fake, runId, services } = await timedOut();
    mainMovedTo(fake, required(20), fakeSha("elsewhere"));

    await endRunsGoneElsewhere(host, services);

    expect(host.gates.get(gateId(runId, "main-ci-timeout"))?.status).toBe("pending");
  });

  it("keeps the gate when the base requires no context", async () => {
    const { host, fake, runId, services } = await timedOut();
    fake.rules = { contexts: [], strict: true };
    mainMovedTo(fake, required(20));

    await endRunsGoneElsewhere(host, services);

    expect(host.gates.get(gateId(runId, "main-ci-timeout"))?.status).toBe("pending");
  });

  it("reports the clear on a dry run and cancels nothing", async () => {
    const { host, fake, runId, services } = await timedOut();
    mainMovedTo(fake, required(20));
    const cleared: string[] = [];

    await endRunsGoneElsewhere(host, services, { dryRun: true, onMainGreen: ({ gateId: id }) => cleared.push(id) });

    expect(cleared).toEqual([gateId(runId, "main-ci-timeout")]);
    expect(host.gates.get(gateId(runId, "main-ci-timeout"))?.status).toBe("pending");
  });
});

/** A run parked on one pre-merge gate, with nothing recorded before it. */
const waitingOn = (gate: string) =>
  defineWorkflow({
    name: SHEPHERD_WORKFLOW,
    steps: [{ id: gate, kind: "assisted" }],
    run: async (ctx) => void (await ctx.assisted(gate, `waiting on ${gate}`, { brief: TEST_BRIEF })),
  });

describe("the gone sweep on every pre-merge gate", () => {
  it.each(["approve-merge", "ci-failed", "stuck-behind", "sh-sent-back", "sh-merge-evidence-gate"].flatMap((gate) => [[gate, "merged"] as const, [gate, "closed"] as const]))(
    "cancels a run waiting on %s once its PR was %s",
    async (gate, outcome) => {
      const fake = fakeGitHub();
      fake.addPr({ headSha: H1 });
      const store = shepherdStoreRef();
      const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
      const host = openFactoryHost({ dbPath: ":memory:", workflows: [waitingOn(gate)], routes, gatePollMs: 5 });
      hosts.push(host);
      const runId = host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1" });
      store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
      await gateOpened(host, gateId(runId, gate));
      Object.assign(fake.pr(1), outcome === "merged" ? { merged: true, state: "closed" } : { state: "closed" });

      const ended = await endRunsGoneElsewhere(host, routes.shepherd!);

      expect(ended).toEqual([{ runId, reason: expect.stringContaining(outcome === "merged" ? LANDED_ELSEWHERE : CLOSED_ELSEWHERE) }]);
      expect(host.gates.get(gateId(runId, gate))?.status).toBe("cancelled");
    },
  );
});
