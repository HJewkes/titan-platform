import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened, outsideActions } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { freezeStoreRef } from "./freeze.js";
import { MAIN_FIXED_MERGE_UPS } from "./main-fixed.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

/**
 * A head red on `validate` from lint that its merge ref inherited from main at CI_BASE, where main's own `validate` was
 * cancelled by a newer push, so the red stands at its parent MAIN_RED; main has since moved to MAIN_TIP.
 */
const HEAD = fakeSha("pr-head");
const MAIN_RED = fakeSha("main-red");
const CI_BASE = fakeSha("main-stale");
const MAIN_TIP = fakeSha("main-tip");
const CI_STARTED = Date.parse("2026-10-30T16:20:00Z");
const at = (iso: string) => new Date(iso).toISOString();
const LINT_STEP = "Run pnpm lint";
const TEST_STEP = "Run pnpm test";
const SEAT = "demo-seat";

const HEAD_JOBS = 1;
const RED_JOBS = 51;
const BASE_JOBS = 101;
const TIP_JOBS = 201;
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

type Conclusions = Partial<Record<"validate" | "dag-check", string>>;

/** Each named check concludes as given, else succeeds; every run is outside Actions, so no red is rerun before a wake. */
const runs = (conclusions: Conclusions, firstId: number, startedAt?: string): CheckRun[] =>
  (["validate", "dag-check"] as const).map((name, i) => outsideActions(successRun(name, firstId + i, startedAt, conclusions[name] ?? "success")));

function jobsFail(fake: FakeGitHub, firstId: number, step: string): void {
  for (const id of [firstId, firstId + 1]) {
    fake.jobSteps.set(id, [{ name: "Set up job", conclusion: "success" }, { name: step, conclusion: "failure" }]);
    fake.jobLogs.set(id, `##[error]${step} failed in a file this PR does not touch\n##[error]Process completed with exit code 1.`);
  }
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  wakes: WakeRequest[];
}

interface Main {
  /** MAIN_RED's `validate` failure step, or "passed". */
  red: string;
  ciBase: Conclusions;
  tip: Conclusions;
  /** Every head an update makes is red as HEAD is, as a head whose own change fails would be. */
  updatesRed?: boolean;
}

const headRuns = (red: boolean, startedAt: string) => (red ? runs({ validate: "failure" }, HEAD_JOBS, startedAt) : runs({}, 301));

/** HEAD is red on `validate`; any head an update makes passes. A woken fixer pushes nothing, so the run waits for a new head. */
function world(main: Main): World {
  const fake = fakeGitHub();
  fake.rules.strict = false;
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, headRuns(pr.headSha === HEAD || main.updatesRed === true, at("2026-10-30T16:20:00Z")));
  fake.setRuns(MAIN_RED, runs(main.red === "passed" ? {} : { validate: "failure" }, RED_JOBS));
  fake.setRuns(CI_BASE, runs(main.ciBase, BASE_JOBS));
  fake.setRuns(MAIN_TIP, runs(main.tip, TIP_JOBS));
  fake.commits.set(MAIN_RED, { sha: MAIN_RED, parents: [], committedAt: at("2026-10-30T16:00:00Z") });
  fake.commits.set(CI_BASE, { sha: CI_BASE, parents: [MAIN_RED], committedAt: at("2026-10-30T16:10:00Z") });
  fake.commits.set(MAIN_TIP, { sha: MAIN_TIP, parents: [CI_BASE], committedAt: at("2026-10-30T16:44:00Z") });
  fake.refs.set("main", MAIN_TIP);
  jobsFail(fake, HEAD_JOBS, LINT_STEP);
  jobsFail(fake, RED_JOBS, main.red);
  jobsFail(fake, TIP_JOBS, TEST_STEP);
  fake.addPr({ headSha: HEAD, behind: true });
  const ref = shepherdStoreRef();
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = { wake: async (_ctx, request) => (wakes.push(request), { kind: "unhandled", reason: "the fixer exited", exited: true, wake: { agent: "impl-a" } }), review: async () => ({ kind: "none" }) };
  const exitNotice: ExitNoticePorts = { seatFor: () => SEAT, lastReport: async () => undefined, send: async () => undefined };
  let clock = CI_STARTED;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, freeze: freezeStoreRef(() => clock), exitNotice, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, store: ref.get(), wakes };
}

function start(w: World): string {
  const policy = { ...OWNER_GATE_POLICY, seat: SEAT };
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  w.store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  return runId;
}

const stepIds = (w: World, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const resultOf = (w: World, runId: string, stepId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).find((result) => result.stepId === stepId)?.data;

async function wokenAndWaiting(w: World, runId: string): Promise<void> {
  await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("await-new-head:0"));
  expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
  expect(w.fake.effects.updateBranch).toBe(0);
}

/** Each stale base-red hold the run acted on waits once on the base, which has already moved, then merges up. */
const mergeUps = (w: World, runId: string) => stepIds(w, runId).filter((id) => id.startsWith("sh-base-wait:"));

describe("a ci-red head whose red came with a stale merge ref (TP-4650)", () => {
  it("merges main up with no fixer woken and no repair spent once main went green past its last same red", async () => {
    const w = world({ red: LINT_STEP, ciBase: { validate: "cancelled" }, tip: {} });
    const runId = start(w);

    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(resultOf(w, runId, "sh-freeze-hold:0")).toMatchObject({ result: { hold: true, baseRed: { baseRef: "main", baseSha: CI_BASE, stale: true, mainFixed: MAIN_TIP } } });
    expect(stepIds(w, runId).filter((id) => id.startsWith("update-branch:sh-freeze-hold:"))).toHaveLength(1);
    expect(w.fake.effects.updateBranch).toBe(1);
    expect(w.wakes).toHaveLength(0);
    expect(stepIds(w, runId)).not.toContain("sh-repair");
  });

  it("wakes the fixer when the head fails at its own step while the merge ref's base run was cancelled", async () => {
    const w = world({ red: TEST_STEP, ciBase: { validate: "cancelled" }, tip: {} });
    const runId = start(w);

    await wokenAndWaiting(w, runId);

    expect(resultOf(w, runId, "sh-freeze-hold:0")).toMatchObject({ result: { hold: false } });
  });

  it("wakes the fixer when main's last finished run before the cancelled one passed", async () => {
    const w = world({ red: "passed", ciBase: { validate: "cancelled" }, tip: {} });
    const runId = start(w);

    await wokenAndWaiting(w, runId);

    expect(resultOf(w, runId, "sh-freeze-hold:0")).toMatchObject({ result: { hold: false } });
  });

  it("wakes the fixer once, then waits for its head, after the run has spent its main-fixed merge-ups", async () => {
    const w = world({ red: LINT_STEP, ciBase: { validate: "cancelled" }, tip: {}, updatesRed: true });
    const runId = start(w);

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("await-new-head:0"));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(w.host.runtime.status(runId)?.currentStep).toBe("await-new-head:0");
    expect(w.wakes).toHaveLength(1);
    expect(w.wakes[0]).toMatchObject({ kind: "ci-red", round: MAIN_FIXED_MERGE_UPS });
    expect(mergeUps(w, runId)).toHaveLength(MAIN_FIXED_MERGE_UPS);
    expect(resultOf(w, runId, `sh-freeze-hold:${MAIN_FIXED_MERGE_UPS}`)).toMatchObject({ result: { hold: false } });
  });

  it("wakes the fixer as before while main is still red past the merge ref's base", async () => {
    const w = world({ red: LINT_STEP, ciBase: { validate: "cancelled" }, tip: { validate: "failure" } });
    const runId = start(w);

    await wokenAndWaiting(w, runId);

    expect(resultOf(w, runId, "sh-freeze-hold:0")).toMatchObject({ result: { hold: false } });
  });

  it("wakes the fixer as before when the failing check passed on main where the head's CI ran", async () => {
    const w = world({ red: LINT_STEP, ciBase: {}, tip: {} });
    const runId = start(w);

    await wokenAndWaiting(w, runId);

    expect(resultOf(w, runId, "sh-freeze-hold:0")).toMatchObject({ result: { hold: false } });
  });
});
