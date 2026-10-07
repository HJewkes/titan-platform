import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { freezeStoreRef, type FreezeStoreRef } from "./freeze.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";
import { watchRow } from "./view.js";

const RED = fakeSha("main-red");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  freeze: FreezeStoreRef;
  wakes: WakeRequest[];
}

const runs = (failing: readonly string[]) => ["validate", "dag-check"].map((name, i) => successRun(name, i + 1, undefined, failing.includes(name) ? "failure" : "success"));

/** PR 1 at H1 fails `prFailing`; main's red sha fails `mainFailing`; every wake is unhandled, so a wake ends at the ci-failed gate. */
function world(prFailing: readonly string[], mainFailing: readonly string[]): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, runs(prFailing));
  fake.setRuns(RED, runs(mainFailing));
  fake.addPr({ headSha: H1 });
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = { wake: async (_ctx, request) => (wakes.push(request), { kind: "unhandled", reason: "no agent in this test" }), review: async () => ({ kind: "none" }) };
  let clock = 0;
  const ref = shepherdStoreRef();
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, freeze, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, store: ref.get(), freeze, wakes };
}

function start(w: World): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  w.store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return runId;
}

const stepIds = (w: World, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const resultOf = (w: World, runId: string, stepId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === stepId)?.data;
const holdOf = (w: World, runId: string) => resultOf(w, runId, "sh-freeze-hold:0");

async function waitingOnThaw(w: World, runId: string): Promise<void> {
  await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("sh-freeze-wait:0"));
}

/** Main's head moves to a sha every Actions check passed at, so a recheck of main thaws the freeze. */
function mainGoesGreen(w: World): void {
  const green = fakeSha("main-green");
  w.fake.refs.set("main", green);
  w.fake.setRuns(green, runs([]));
}

/** From now on every read of PR 1 fails, as a GitHub outage would. */
function prReadsFail(w: World): void {
  w.fake.onGetPr = () => {
    throw new Error("GitHub answered 502");
  };
}

describe("a ci-red wake under a frozen main", () => {
  it("holds a PR whose failing checks all fail on the red sha: no wake, no repair, and the wait names why", async () => {
    const w = world(["validate"], ["validate", "dag-check"]);
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);

    await waitingOnThaw(w, runId);
    await sleep(50, new AbortController().signal);

    expect(w.wakes).toEqual([]);
    expect(stepIds(w, runId)).not.toContain("sh-repair");
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: true, reason: expect.stringContaining("waiting for the thaw") } });
    const row = watchRow({ registration: w.store.byRun(runId)!, run: w.host.runtime.status(runId)! });
    expect(row.nextAction).toContain(`main is frozen red at ${RED.slice(0, 7)}`);
  });

  it("wakes and spends a repair as before when a failing check is not failing on the red sha", async () => {
    const w = world(["validate", "dag-check"], ["validate"]);
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(stepIds(w, runId)).toContain("sh-repair");
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("dag-check") } });
  });

  it("wakes and spends a repair as before when the repo is not frozen", async () => {
    const w = world(["validate"], ["validate"]);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(stepIds(w, runId)).toContain("sh-repair");
    expect(stepIds(w, runId)).not.toContain("sh-freeze-wait:0");
  });

  it("re-reads CI after the thaw and decides afresh", async () => {
    const w = world(["validate"], ["validate"]);
    const { episode } = w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    w.freeze.get().release(REPO, episode);
    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(stepIds(w, runId)).toEqual(expect.arrayContaining(["sh-freeze-wait:0", "land-rules:r1", "sh-freeze-hold:1", "sh-repair"]));
    expect(w.wakes.map((wake) => [wake.kind, wake.round])).toEqual([["ci-red", 1]]);
  });

  it("holds a fixer's own PR as before: the fixer for the freeze is woken to repair it", async () => {
    const w = world(["validate"], ["validate"]);
    const { episode } = w.freeze.get().freeze(REPO, RED);
    w.freeze.get().setFixTask(REPO, episode, "demo/1");
    w.freeze.get().setFixer(REPO, episode, "impl-a");
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("fixer's PR") } });
  });

  it("wakes as before when main's checks cannot be read", async () => {
    const w = world(["validate"], ["validate"]);
    const listCheckRuns = w.fake.wire.listCheckRuns;
    w.fake.wire.listCheckRuns = async (repo, sha) => (sha === RED ? Promise.reject(new Error("GitHub answered 502")) : listCheckRuns(repo, sha));
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("validate") } });
  });

  it("wakes rather than fails the run when the freeze store throws inside the hold", async () => {
    const w = world(["validate"], ["validate"]);
    w.freeze.get().freeze(REPO, RED);
    vi.spyOn(w.freeze.get(), "get").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("database is locked") } });
  });

  it("leaves the wait for the next round when the PR moves to a new head", async () => {
    const w = world(["validate"], ["validate"]);
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    w.fake.pushHead(1, fakeSha("pr-new-head"));

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("sh-freeze-wait:1"));
    expect(resultOf(w, runId, "sh-freeze-wait:0")).toMatchObject({ result: { thawed: false, headSha: fakeSha("pr-new-head") } });
    expect(w.wakes).toEqual([]);
  });

  it("ends the run when the PR is closed during the wait", async () => {
    const w = world(["validate"], ["validate"]);
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    w.fake.pr(1).state = "closed";

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.status).toBe("completed"));
    expect(resultOf(w, runId, "sh-freeze-wait:0")).toMatchObject({ result: { thawed: false, headSha: H1 } });
    expect(w.wakes).toEqual([]);
  });

  it("thaws the freeze from inside the wait once main is green after the red", async () => {
    const w = world(["validate"], ["validate"]);
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    mainGoesGreen(w);

    await vi.waitFor(() => expect(w.freeze.get().isFrozen(REPO)).toBe(false));
    await vi.waitFor(() => expect(resultOf(w, runId, "sh-freeze-wait:0")).toMatchObject({ result: { thawed: true } }));
  });

  it("still rechecks main every FREEZE_RECHECK_MS while every read of the PR fails", async () => {
    const w = world(["validate"], ["validate"]);
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    prReadsFail(w);
    mainGoesGreen(w);

    await vi.waitFor(() => expect(w.freeze.get().isFrozen(REPO)).toBe(false), { timeout: 5_000 });
  });

  it("wakes the run to decide afresh once the wait reaches its limit, and neither fails nor wakes an agent", async () => {
    const w = world(["validate"], ["validate"]);
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);

    await vi.waitFor(() => expect(stepIds(w, runId)).toContain("sh-freeze-hold:1"), { timeout: 10_000 });

    expect(resultOf(w, runId, "sh-freeze-wait:0")).toMatchObject({ result: { thawed: false, expired: true, headSha: H1 } });
    expect(w.host.runtime.status(runId)?.status).toBe("running");
    expect(w.wakes).toEqual([]);
  });

  it("updates the same red head after a thaw on a non-strict repo before a repair is spent on it", async () => {
    const w = world(["validate"], ["validate"]);
    w.fake.rules.strict = false;
    w.fake.pr(1).behind = true;
    const { episode } = w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    w.freeze.get().release(REPO, episode);
    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.fake.effects.updateBranch).toBe(1);
    expect(w.wakes.map((wake) => wake.headSha)).not.toContain(H1);
  });
});
