import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, outsideActions, swallowUpdates } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { freezeStoreRef, type FreezeStoreRef } from "./freeze.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStore, type ShepherdStoreRef } from "./store.js";
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
  /** Every seat notice sent, as `seat: text`. */
  told: string[];
}

interface Wiring {
  fake: FakeGitHub;
  ref: ShepherdStoreRef;
  freeze: FreezeStoreRef;
  wakes: WakeRequest[];
  told: string[];
}

/** `firstId` keeps each sha's job ids apart, as GitHub's are, so each job's steps are its own. */
const actionsRuns = (failing: readonly string[], firstId = 1, conclusion = "failure") =>
  ["validate", "dag-check"].map((name, i) => successRun(name, firstId + i, undefined, failing.includes(name) ? conclusion : "success"));
const runs = (failing: readonly string[], firstId?: number, conclusion?: string) => actionsRuns(failing, firstId, conclusion).map(outsideActions);
const TEST_STEP = "Run pnpm test";
const HEAD_JOBS = 1;
const RED_JOBS = 101;
const BASE_JOBS = 201;

/** Every job from `firstId` failed at `step`, after a green setup step. */
function jobsFailAt(fake: FakeGitHub, firstId: number, step = TEST_STEP): void {
  for (const id of [firstId, firstId + 1]) fake.jobSteps.set(id, [{ name: "Set up job", conclusion: "success" }, { name: step, conclusion: "failure" }, { name: "Complete job", conclusion: "skipped" }]);
}

/**
 * Every wake is unhandled and the repo has no single seat, so a wake ends at the ci-failed gate and only a run whose
 * policy names a seat is told. A second host on the same `dbPath` stands in for a restart.
 */
function openHost({ fake, ref, freeze, wakes, told }: Wiring, dbPath = ":memory:"): FactoryHost {
  const phases: ShepherdPhases = { wake: async (_ctx, request) => (wakes.push(request), { kind: "unhandled", reason: "no agent in this test" }), review: async () => ({ kind: "none" }) };
  const exitNotice: ExitNoticePorts = { seatFor: () => undefined, lastReport: async () => undefined, send: async (seat, text) => void told.push(`${seat}: ${text}`) };
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, freeze, exitNotice, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

/** PR 1 at H1 fails `prFailing`; main's red sha fails `mainFailing`. */
function world(prFailing: readonly string[], mainFailing: readonly string[], dbPath?: string): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, runs(prFailing));
  fake.setRuns(RED, runs(mainFailing, RED_JOBS));
  [HEAD_JOBS, RED_JOBS, BASE_JOBS].forEach((firstId) => jobsFailAt(fake, firstId));
  fake.addPr({ headSha: H1 });
  let clock = 0;
  const wiring: Wiring = { fake, ref: shepherdStoreRef(), freeze: freezeStoreRef(() => clock++), wakes: [], told: [] };
  const host = openHost(wiring, dbPath);
  return { host, fake, store: wiring.ref.get(), freeze: wiring.freeze, wakes: wiring.wakes, told: wiring.told };
}

function start(w: World, policy: EffectivePolicy = OWNER_GATE_POLICY): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  w.store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
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

  it("wakes and spends a repair when a failing check fails on the red sha at another step", async () => {
    const w = world(["validate"], ["validate"]);
    jobsFailAt(w.fake, RED_JOBS, "Require a changeset for package changes");
    w.freeze.get().freeze(REPO, RED);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("validate") } });
  });

  it("wakes and spends a repair as before when the repo is not frozen", async () => {
    const w = world(["validate"], ["validate"]);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(stepIds(w, runId)).toContain("sh-repair");
    expect(stepIds(w, runId)).not.toContain("sh-freeze-wait:0");
  });

  it("reruns the same red head after a thaw that left main's base unmoved, then decides afresh", async () => {
    const w = world(["validate"], ["validate"]);
    w.fake.onGetPr = (pr) => w.fake.setRuns(pr.headSha, actionsRuns(["validate"]));
    const { episode } = w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    w.freeze.get().release(REPO, episode);
    await gateOpened(w.host, gateId(runId, "ci-failed"));

    const ids = stepIds(w, runId);
    expect(ids).toEqual(expect.arrayContaining(["sh-freeze-wait:0", "rerun:sh-freeze-hold:0", "land-rules:r1", "sh-freeze-hold:1", "sh-repair"]));
    expect(ids.indexOf("rerun:sh-freeze-hold:0")).toBeLessThan(ids.indexOf("land-rules:r1"));
    expect(w.fake.effects).toMatchObject({ updateBranch: 0, rerunFailedJobs: 1 });
    expect(w.wakes.map((wake) => [wake.kind, wake.round])).toEqual([["ci-red", 2]]);
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

  it("stops as update-branch-unmoved when the update after a thaw never moves the red head, and spends no repair", async () => {
    const w = world(["validate"], ["validate"]);
    w.fake.rules.strict = false;
    w.fake.pr(1).behind = true;
    swallowUpdates(w.fake, 99);
    const { episode } = w.freeze.get().freeze(REPO, RED);
    const runId = start(w);
    await waitingOnThaw(w, runId);

    w.freeze.get().release(REPO, episode);
    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.status).toBe("completed"), { timeout: 5_000 });

    expect(resultOf(w, runId, "update-branch:sh-freeze-hold:0")).toMatchObject({ result: { unmoved: true, headSha: H1 } });
    expect(resultOf(w, runId, "sh-stopped")).toMatchObject({ result: { kind: "stopped", reason: "update-branch-unmoved", headSha: H1 } });
    expect(stepIds(w, runId)).not.toContain("sh-repair");
    expect(w.wakes).toEqual([]);
  });
});

const BASE = fakeSha("base");

/** The PR's base head, `main` at BASE, ends every check in `failing` with `conclusion`. */
function baseFails(w: World, failing: readonly string[], conclusion = "failure"): void {
  w.fake.setRuns(BASE, runs(failing, BASE_JOBS, conclusion));
}

async function waitingOnBase(w: World, runId: string): Promise<void> {
  await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("sh-base-wait:0"));
}

describe("a ci-red wake on a PR whose base head is red", () => {
  it("holds a PR whose failing checks all fail at the base head: no wake, no repair, one base-red notice, and a base wait", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate", "dag-check"]);
    const runId = start(w, { ...OWNER_GATE_POLICY, seat: "demo-seat" });

    await waitingOnBase(w, runId);
    await sleep(50, new AbortController().signal);

    expect(w.wakes).toEqual([]);
    expect(stepIds(w, runId)).not.toContain("sh-repair");
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: true, episode: null, baseRed: { baseRef: "main", baseSha: BASE } } });
    expect(w.told).toHaveLength(1);
    expect(w.told[0]).toMatch(new RegExp(`^demo-seat: Shepherd: ${REPO}#1 at head ${H1}: base-red: the base main is red at ${BASE.slice(0, 7)}`));
    const row = watchRow({ registration: w.store.byRun(runId)!, run: w.host.runtime.status(runId)! });
    expect(row.nextAction).toContain(`the base main is red at ${BASE.slice(0, 7)}`);
  });

  it("wakes as before when one failing check passes at the base head", async () => {
    const w = world(["validate", "dag-check"], []);
    baseFails(w, ["validate"]);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("dag-check") } });
    expect(stepIds(w, runId)).not.toContain("sh-base-wait:0");
  });

  it("wakes a fixer when the head fails the base's red check at another step: an out-of-memory test run under a base red on its changeset step", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate"]);
    jobsFailAt(w.fake, BASE_JOBS, "Require a changeset for package changes");
    const runId = start(w, { ...OWNER_GATE_POLICY, seat: "demo-seat" });

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("failing here but not on main") } });
    expect(stepIds(w, runId)).not.toContain("sh-base-wait:0");
    expect(w.told.filter((text) => text.includes("base-red"))).toEqual([]);
  });

  it("wakes a fixer when the head's failing step cannot be read, though its check fails at the base head", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate"]);
    w.fake.jobSteps.delete(HEAD_JOBS);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(stepIds(w, runId)).not.toContain("sh-base-wait:0");
  });

  it("wakes as before when the base head's only red is a cancelled run", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate"], "cancelled");
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("failing here but not on main") } });
    expect(stepIds(w, runId)).not.toContain("sh-base-wait:0");
  });

  it("decides afresh once the base wait reaches its limit, and neither fails nor wakes an agent", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate"]);
    const runId = start(w);

    await vi.waitFor(() => expect(stepIds(w, runId)).toContain("sh-freeze-hold:1"), { timeout: 10_000 });

    expect(resultOf(w, runId, "sh-base-wait:0")).toMatchObject({ result: { baseMoved: false, expired: true, headSha: H1 } });
    expect(w.host.runtime.status(runId)?.status).toBe("running");
    expect(w.wakes).toEqual([]);
  });

  it("ends the run when the PR is closed during the base wait", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate"]);
    const runId = start(w);
    await waitingOnBase(w, runId);

    w.fake.pr(1).state = "closed";

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.status).toBe("completed"));
    expect(resultOf(w, runId, "sh-base-wait:0")).toMatchObject({ result: { baseMoved: false, headSha: H1 } });
    expect(w.wakes).toEqual([]);
  });

  it("wakes as before when the base head's checks cannot be read", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate"]);
    const listCheckRuns = w.fake.wire.listCheckRuns;
    w.fake.wire.listCheckRuns = async (repo, sha) => (sha === BASE ? Promise.reject(new Error("GitHub answered 502")) : listCheckRuns(repo, sha));
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("GitHub answered 502") } });
  });

  it("ends the wait when the base head moves, updates the red head, then decides afresh against the new base", async () => {
    const w = world(["validate"], []);
    w.fake.rules.strict = false;
    w.fake.pr(1).behind = true;
    baseFails(w, ["validate"]);
    const runId = start(w);
    await waitingOnBase(w, runId);

    const fixedBase = fakeSha("base-fixed");
    w.fake.refs.set("main", fixedBase);
    w.fake.setRuns(fixedBase, runs([]));
    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(resultOf(w, runId, "sh-base-wait:0")).toMatchObject({ result: { baseMoved: true, headSha: H1 } });
    expect(stepIds(w, runId)).toContain("update-branch:sh-freeze-hold:0");
    expect(w.fake.effects.updateBranch).toBe(1);
    expect(w.wakes.map((wake) => wake.headSha)).not.toContain(H1);
    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
  });

  it("leaves the wait for the next round when the PR moves to a new head", async () => {
    const w = world(["validate"], []);
    baseFails(w, ["validate"]);
    const runId = start(w);
    await waitingOnBase(w, runId);

    w.fake.pushHead(1, fakeSha("pr-new-head"));

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("sh-base-wait:1"));
    expect(resultOf(w, runId, "sh-base-wait:0")).toMatchObject({ result: { baseMoved: false, headSha: fakeSha("pr-new-head") } });
    expect(w.wakes).toEqual([]);
  });

  it("replays a hold recorded before base-red as recorded: no base wait and no notice", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp2452-")), "factory.db");
    const w = world(["validate"], [], dbPath);
    const runId = start(w);
    await gateOpened(w.host, gateId(runId, "ci-failed"));
    w.host.close();

    baseFails(w, ["validate"]);
    const second = openHost({ fake: w.fake, ref: shepherdStoreRef(), freeze: freezeStoreRef(), wakes: w.wakes, told: w.told }, dbPath);
    await second.adopt();
    await gateOpened(second, gateId(runId, "ci-failed"));
    await sleep(50, new AbortController().signal);

    const ids = Object.values(second.runtime.status(runId)!.stepResults).map((result) => result.stepId);
    expect(ids).not.toContain("sh-base-wait:0");
    expect(holdOf({ ...w, host: second }, runId)).toMatchObject({ result: { hold: false } });
    expect(w.told).toEqual([]);
  });
});

const BASE_PARENT = fakeSha("base-parent");
const FIXED = fakeSha("base-fixed");
/** Every run `runs` builds starts at the `successRun` default. */
const CI_STARTED = Date.parse("2026-01-01T00:00:00Z");
const at = (offsetMinutes: number) => new Date(CI_STARTED + offsetMinutes * 60_000).toISOString();

/**
 * Main ran BASE_PARENT (green) then BASE (red on `validate`), landed `baseAt` minutes from the PR's CI start, and is
 * already at FIXED (green). Each head the update makes passes, so only H1's red is the base's.
 */
function fixedBaseWorld(baseAt: number): World {
  const w = world(["validate"], []);
  w.fake.rules.strict = false;
  w.fake.pr(1).behind = true;
  w.fake.onGetPr = (pr) => w.fake.setRuns(pr.headSha, runs(pr.headSha === H1 ? ["validate"] : []));
  w.fake.setRuns(BASE_PARENT, runs([]));
  baseFails(w, ["validate"]);
  w.fake.setRuns(FIXED, runs([]));
  w.fake.commits.set(BASE_PARENT, { sha: BASE_PARENT, parents: [], committedAt: at(baseAt - 30) });
  w.fake.commits.set(BASE, { sha: BASE, parents: [BASE_PARENT], committedAt: at(baseAt) });
  w.fake.commits.set(FIXED, { sha: FIXED, parents: [BASE], committedAt: at(60) });
  w.fake.refs.set("main", FIXED);
  return w;
}

describe("a ci-red wake on a PR whose CI ran against a base that has since been fixed", () => {
  it("merges the red head up with no wake, repair or notice, and the fresh CI lands it green with no seat or implementer push", async () => {
    const w = fixedBaseWorld(-10);
    const runId = start(w, { ...OWNER_GATE_POLICY, seat: "demo-seat" });

    await vi.waitFor(() => expect(stepIds(w, runId)).toContain("update-branch:sh-freeze-hold:0"));
    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(holdOf(w, runId)).toMatchObject({ result: { hold: true, baseRed: { baseRef: "main", baseSha: BASE, stale: true } } });
    expect(resultOf(w, runId, "sh-base-wait:0")).toMatchObject({ result: { baseMoved: true, headSha: H1 } });
    expect(w.fake.effects).toMatchObject({ updateBranch: 1, rerunFailedJobs: 0 });
    expect(stepIds(w, runId)).not.toContain("sh-repair");
    expect(stepIds(w, runId)).not.toContain("sh-head-origin");
    expect(w.wakes).toEqual([]);
    expect(w.told.filter((text) => text.includes("base-red"))).toEqual([]);
  });

  it("wakes as before when the base its CI ran against was green, though a later base was red", async () => {
    const w = fixedBaseWorld(10);
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(holdOf(w, runId)).toMatchObject({ result: { hold: false, reason: expect.stringContaining("failing here but not on main") } });
  });

  it("wakes as before when a base commit's landing time is unknown", async () => {
    const w = fixedBaseWorld(-10);
    w.fake.commits.set(BASE, { sha: BASE, parents: [BASE_PARENT] });
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(w.fake.effects.updateBranch).toBe(0);
  });

  it("wakes as before when the base its CI ran against is more than 20 commits back", async () => {
    const w = fixedBaseWorld(-10);
    const later = Array.from({ length: 20 }, (_, i) => fakeSha(`base-later-${i}`));
    later.forEach((sha, i) => w.fake.commits.set(sha, { sha, parents: [later[i - 1] ?? BASE], committedAt: at(1 + i) }));
    w.fake.refs.set("main", later.at(-1)!);
    w.fake.setRuns(later.at(-1)!, runs([]));
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
  });
});
