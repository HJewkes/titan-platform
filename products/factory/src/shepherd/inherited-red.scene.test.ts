import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened, outsideActions } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { freezeStoreRef } from "./freeze.js";
import type { ShepherdPhases, WakeOutcome, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { MAX_REPAIRS } from "./route-table.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

/** tp#1499's shape: a head red on `validate` from main's max-line-length error, read while main's own run was pending. */
const HEAD = fakeSha("a64fb24e");
const MAIN_PARENT = fakeSha("main-parent");
const MAIN_RED = fakeSha("commands-131");
const MAIN_FIX = fakeSha("tp1514");
const CI_STARTED = Date.parse("2026-10-15T16:20:00Z");
const at = (iso: string) => new Date(iso).toISOString();
const LINT_STEP = "Run pnpm lint";
const LINT_ERROR = "##[error]src/commands.ts:131:1 error This line has a length of 131. Maximum allowed is 120 max-len";

const HEAD_JOBS = 1;
const MAIN_JOBS = 101;
const SEAT = "demo-seat";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  wakes: WakeRequest[];
  told: string[];
  clock(): number;
}

/** `firstId` keeps each sha's job ids apart, as GitHub's are; every run is outside Actions, so no red is rerun before the wake. */
const runs = (failing: readonly string[], firstId: number, startedAt?: string): CheckRun[] =>
  ["validate", "dag-check"].map((name, i) => outsideActions(successRun(name, firstId + i, startedAt, failing.includes(name) ? "failure" : "success")));

/** Every job from `firstId` failed the lint step with main's error, and names no test file, so no flake check reruns it. */
function jobsFailLint(fake: FakeGitHub, firstId: number): void {
  for (const id of [firstId, firstId + 1]) {
    fake.jobSteps.set(id, [{ name: "Set up job", conclusion: "success" }, { name: LINT_STEP, conclusion: "failure" }]);
    fake.jobLogs.set(id, [LINT_ERROR, "##[error]Process completed with exit code 1."].join("\n"));
  }
}

/** Answers each wake; it may push a head, which `red` marks red as HEAD is. */
type Wake = (fake: FakeGitHub, red: Set<string>) => WakeOutcome;

const unhandled: Wake = () => ({ kind: "unhandled", reason: "no agent in this test" });

/**
 * Main's head is MAIN_RED with its `validate` still running when HEAD's CI reads red on `headFailing`; every head an
 * update makes passes. The seat owns the repo, so an unhandled wake is the seat's and the run waits for a new head.
 */
function world(headFailing: readonly string[], wake: Wake = unhandled): World {
  const fake = fakeGitHub();
  const red = new Set([HEAD]);
  fake.rules.strict = false;
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, red.has(pr.headSha) ? runs(headFailing, HEAD_JOBS, at("2026-10-15T16:20:00Z")) : runs([], 301));
  fake.setRuns(MAIN_PARENT, runs([], 201));
  fake.setRuns(MAIN_RED, [{ ...runs([], MAIN_JOBS)[0]!, status: "in_progress", conclusion: null }, runs([], MAIN_JOBS)[1]!]);
  fake.commits.set(MAIN_PARENT, { sha: MAIN_PARENT, parents: [], committedAt: at("2026-10-15T15:40:00Z") });
  fake.commits.set(MAIN_RED, { sha: MAIN_RED, parents: [MAIN_PARENT], committedAt: at("2026-10-15T16:10:00Z") });
  fake.commits.set(MAIN_FIX, { sha: MAIN_FIX, parents: [MAIN_RED], committedAt: at("2026-10-15T16:44:00Z") });
  fake.refs.set("main", MAIN_RED);
  [HEAD_JOBS, MAIN_JOBS].forEach((firstId) => jobsFailLint(fake, firstId));
  fake.addPr({ headSha: HEAD, behind: true });
  const ref = shepherdStoreRef();
  const wakes: WakeRequest[] = [];
  const told: string[] = [];
  const phases: ShepherdPhases = { wake: async (_ctx, request) => (wakes.push(request), wake(fake, red)), review: async () => ({ kind: "none" }) };
  const exitNotice: ExitNoticePorts = { seatFor: () => SEAT, lastReport: async () => undefined, send: async (seat, text) => void told.push(`${seat}: ${text}`) };
  let clock = CI_STARTED;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, freeze: freezeStoreRef(() => clock), exitNotice, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, store: ref.get(), wakes, told, clock: () => clock };
}

function start(w: World): string {
  const policy = { ...OWNER_GATE_POLICY, seat: SEAT };
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  w.store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  return runId;
}

/** Main's run at MAIN_RED completes red on `validate`, and tp#1514 lands the green fix at 16:44Z. */
function mainFixed(w: World): void {
  w.fake.setRuns(MAIN_RED, runs(["validate"], MAIN_JOBS));
  w.fake.setRuns(MAIN_FIX, runs([], 401));
  w.fake.refs.set("main", MAIN_FIX);
}

const results = (w: World, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults);
const stepIds = (w: World, runId: string) => results(w, runId).map((result) => result.stepId);
const resultOf = (w: World, runId: string, stepId: string) => results(w, runId).find((result) => result.stepId === stepId)?.data;

async function waitingForNewHead(w: World, runId: string, timeout?: number): Promise<void> {
  await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("await-new-head:0"), { timeout });
}

/** The run left the wait on its own, merged the red head up once and reached its merge gate on `repairs` repairs. */
async function expectMergedUp(w: World, runId: string, repairs = 1, headSha = HEAD): Promise<void> {
  await gateOpened(w.host, gateId(runId, "approve-merge"));

  expect(resultOf(w, runId, "await-new-head:0")).toMatchObject({ result: { headSha, baseRed: true } });
  const holds = stepIds(w, runId).filter((id) => id.startsWith("sh-freeze-hold:"));
  expect(resultOf(w, runId, holds.at(-1)!)).toMatchObject({ result: { hold: true, baseRed: { baseRef: "main", baseSha: MAIN_RED, stale: true } } });
  expect(stepIds(w, runId).filter((id) => id.startsWith("update-branch:sh-freeze-hold:"))).toHaveLength(1);
  expect(w.fake.effects.updateBranch).toBe(1);
  expect(stepIds(w, runId).filter((id) => id === "sh-repair")).toHaveLength(repairs);
  expect(w.wakes).toHaveLength(repairs);
  expect(w.wakes.every((wake) => wake.kind === "ci-red")).toBe(true);
}

describe("a ci-red wait whose red main fixed while no fixer was live (tp#1499)", () => {
  it("leaves await-new-head once main is green, merges the red head up and reaches the merge gate with one repair", async () => {
    const w = world(["validate"]);
    const runId = start(w);
    await waitingForNewHead(w, runId);

    expect(resultOf(w, runId, "sh-freeze-hold:0")).toMatchObject({ result: { hold: false } });
    expect(w.told.some((text) => text.startsWith(`${SEAT}: `))).toBe(true);

    mainFixed(w);

    await expectMergedUp(w, runId);
  });

  it("leaves the wait the same way after a woken fixer exited with no push", async () => {
    const w = world(["validate"], () => ({ kind: "unhandled", reason: "the fixer exited", exited: true, wake: { agent: "impl-a" } }));
    const runId = start(w);
    await waitingForNewHead(w, runId);

    expect(stepIds(w, runId)).toContain("sh-flake-check:0");

    mainFixed(w);

    await expectMergedUp(w, runId);
  });

  it("leaves the wait the same way after the repair budget ran out at a red head", async () => {
    let pushed = 0;
    const w = world(["validate"], (fake, red) => {
      const head = fakeSha(`refixed-${++pushed}`);
      red.add(head);
      fake.pushHead(1, head);
      return { kind: "woken", agent: "impl-a" };
    });
    const runId = start(w);
    await waitingForNewHead(w, runId, 20_000);
    const last = fakeSha(`refixed-${MAX_REPAIRS}`);

    expect(resultOf(w, runId, "await-new-head:0")).toBeUndefined();
    expect(w.told.some((text) => text.includes("repair budget"))).toBe(true);

    mainFixed(w);

    await expectMergedUp(w, runId, MAX_REPAIRS, last);
  });

  it("still waits for a new head when the head fails a check main never failed", async () => {
    const w = world(["dag-check"]);
    const runId = start(w);
    await waitingForNewHead(w, runId);
    mainFixed(w);
    const fixedAt = w.clock();

    await vi.waitFor(() => expect(w.clock() - fixedAt).toBeGreaterThan(35 * 60_000));

    expect(w.host.runtime.status(runId)?.currentStep).toBe("await-new-head:0");
    expect(w.fake.effects.updateBranch).toBe(0);
    expect(stepIds(w, runId)).not.toContain("await-new-head:0");
  });
});
