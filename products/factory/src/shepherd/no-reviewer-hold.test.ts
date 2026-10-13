import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { partialFake } from "@titan-design/test-kit";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { shepherdEventMigration } from "./events.js";
import { checkHoldReason } from "./hold-reason.js";
import { NO_REVIEWER_STEPS, NO_REVIEWER_WAIT_LIMIT_MS, noReviewerHeld, noReviewerRoutes } from "./no-reviewer-hold.js";
import type { ShepherdDeps } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { holdSlotsMigration, parkSettledMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration, type ShepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("no-reviewer-head");
const REFUSAL = "the reviewer dispatch was refused: ReviewCheckoutUnusable";
const HELD = `no-reviewer: ${REFUSAL} at ${HEAD}; TP-2446`;
const T0 = Date.parse("2026-10-12T11:12:41.000Z");

function migrated(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), parkSettledMigration(21)]);
  return db;
}

function scene(options: { alert?: (repo: string, text: string) => Promise<void> } = {}) {
  const clock = { now: T0 };
  const store = new ShepherdStore(migrated(), () => clock.now);
  const ref: ShepherdStoreRef = { get: () => store, bind: () => () => undefined };
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: HEAD });
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store: ref, now: () => clock.now, sleep: async (ms: number) => void (clock.now += ms), pollMs: 60_000, agentChatBin: "agent-chat" };
  const alerts: { repo: string; text: string }[] = [];
  const routes = noReviewerRoutes(deps, options.alert ?? (async (repo, text) => void alerts.push({ repo, text })));
  /** Each wait poll is a chance for the world to move, as the owner or a push would between polls. */
  let onSleep: () => void = () => undefined;
  deps.sleep = async (ms: number) => {
    clock.now += ms;
    onSleep();
  };
  const run = async (match: string, input: object) => {
    const outcome = await routes.find((route) => route.match === match)!.runner.run({ runId: "r", workflowName: "w", stepId: match, iteration: 0, prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 0, requestKey: "k" });
    return outcome.ok ? JSON.parse(outcome.output).result : outcome;
  };
  store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  const hold = () => run("sh-no-reviewer-hold", { repo: REPO, pr: 1, head: HEAD, runId: "run-1", refusal: REFUSAL });
  const wait = (standing = HELD) => run("sh-no-reviewer-wait", { repo: REPO, pr: 1, head: HEAD, runId: "run-1", refusal: REFUSAL, reason: HELD, standing });
  const between = (fn: () => void) => void (onSleep = fn);
  return { clock, store, fake, alerts, hold, wait, between, run };
}

describe("sh-no-reviewer-hold", () => {
  it("holds an unheld run as no-reviewer and alerts its repo once", async () => {
    const s = scene();

    const held = await s.hold();

    expect(held).toEqual({ held: true, placed: true, alerted: true, reason: HELD, standing: HELD });
    expect(checkHoldReason(HELD)).toEqual({ ok: true, holdClass: "no-reviewer" });
    expect(s.store.byRun("run-1")).toMatchObject({ held: true, holdReason: HELD });
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]!.repo).toBe(REPO);
    expect(s.alerts[0]!.text).toContain(`titan-factory shepherd release ${REPO}#1 --head ${HEAD} --class no-reviewer`);
  });

  it("a second hold at the same head sends no second alert", async () => {
    const s = scene();
    await s.hold();

    const again = await s.hold();

    expect(again).toMatchObject({ held: true, placed: false, alerted: false, standing: HELD });
    expect(s.alerts).toHaveLength(1);
  });

  it("leaves another class's hold in place and does not alert", async () => {
    const s = scene();
    s.store.hold("run-1", "stalled: waiting on the design call; TP-1");

    const held = await s.hold();

    expect(held).toMatchObject({ held: true, placed: false, alerted: false, standing: "stalled: waiting on the design call; TP-1" });
    expect(s.store.byRun("run-1")?.holdReason).toBe("stalled: waiting on the design call; TP-1");
    expect(s.alerts).toHaveLength(0);
  });

  it("an alert that throws still holds and records alerted false", async () => {
    const s = scene({ alert: async () => Promise.reject(new Error("no seat owns octo/demo")) });

    const held = await s.hold();

    expect(held).toMatchObject({ held: true, placed: true, alerted: false });
    expect(s.store.byRun("run-1")).toMatchObject({ held: true, holdReason: HELD });
  });

  it("does not hold a run that has no registration", async () => {
    const s = scene();

    const held = await s.run("sh-no-reviewer-hold", { repo: REPO, pr: 1, head: HEAD, runId: "run-unknown", refusal: REFUSAL });

    expect(held).toMatchObject({ held: false, placed: false, alerted: false });
    expect(s.alerts).toHaveLength(0);
  });
});

describe("sh-no-reviewer-wait", () => {
  it("resumes released when the owner releases the hold", async () => {
    const s = scene();
    await s.hold();
    s.between(() => s.store.release("run-1"));

    expect(await s.wait()).toEqual({ resumed: "released" });
  });

  it("resumes head-moved when the PR head changes, keeping the hold for the next review to replace", async () => {
    const s = scene();
    await s.hold();
    s.between(() => s.fake.pushHead(1, fakeSha("no-reviewer-next")));

    expect(await s.wait()).toEqual({ resumed: "head-moved" });
    expect(s.store.byRun("run-1")?.holdReason).toBe(HELD);
  });

  it("keeps waiting while the hold and head stand", async () => {
    const s = scene();
    await s.hold();
    let polls = 0;
    s.between(() => void (++polls === 3 && s.store.release("run-1")));

    expect(await s.wait()).toEqual({ resumed: "released" });
    expect(polls).toBe(3);
  });

  it("a closed PR drops only its own hold", async () => {
    const s = scene();
    await s.hold();
    s.fake.pr(1).state = "closed";

    expect(await s.wait()).toEqual({ resumed: "closed" });
    expect(s.store.byRun("run-1")?.held).toBe(false);
  });

  it("a closed PR leaves another class's hold in place", async () => {
    const s = scene();
    s.store.hold("run-1", "stalled: waiting on the design call; TP-1");
    s.fake.pr(1).state = "closed";

    expect(await s.wait("stalled: waiting on the design call; TP-1")).toEqual({ resumed: "closed" });
    expect(s.store.byRun("run-1")?.holdReason).toBe("stalled: waiting on the design call; TP-1");
  });

  it("expires after 60 min with the hold still in place", async () => {
    const s = scene();
    await s.hold();

    expect(await s.wait()).toEqual({ resumed: "expired" });
    expect(s.clock.now - T0).toBeGreaterThanOrEqual(NO_REVIEWER_WAIT_LIMIT_MS);
    expect(s.store.byRun("run-1")).toMatchObject({ held: true, holdReason: HELD });
  });

  it("a PR read that throws keeps the hold until expiry", async () => {
    const s = scene();
    await s.hold();
    s.fake.onGetPr = () => {
      throw new Error("GitHub answered 502");
    };

    expect(await s.wait()).toEqual({ resumed: "expired" });
    expect(s.store.byRun("run-1")).toMatchObject({ held: true, holdReason: HELD });
  });
});

/** A context whose hold step answers `held`, and whose wait answers released; it records the step ids dispatched. */
function stepContext(held: object) {
  const steps: string[] = [];
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    steps.push(stepId);
    const result = stepId.startsWith("sh-no-reviewer-hold") ? held : { resumed: "released" };
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result }) };
  }
  return { ctx: partialFake<WorkflowContext>({ runId: "run-1", dispatch }), steps };
}

describe("NO_REVIEWER_STEPS", () => {
  it("declares exactly the steps the routes answer, so a registered route is never refused as undeclared", () => {
    const routes = noReviewerRoutes(partialFake<ShepherdDeps>({ now: () => T0 }));

    expect(NO_REVIEWER_STEPS.map((declared) => declared.id)).toEqual(routes.map((route) => route.match));
  });
});

describe("noReviewerHeld", () => {
  it("holds, waits, and answers none with cause not-started so the refusal counts as no failed round", async () => {
    const { ctx, steps } = stepContext({ held: true, placed: true, alerted: true, reason: HELD, standing: HELD });

    const verdict = await noReviewerHeld(ctx, { repo: REPO, pr: 1, head: HEAD }, REFUSAL);

    expect(verdict).toEqual({ kind: "none", cause: "not-started", reason: HELD });
    expect(steps).toEqual([`sh-no-reviewer-hold:${HEAD}`, `sh-no-reviewer-wait:${HEAD}`]);
  });

  it("skips the wait when nothing could be held", async () => {
    const { ctx, steps } = stepContext({ held: false, placed: false, alerted: false, reason: HELD });

    await noReviewerHeld(ctx, { repo: REPO, pr: 1, head: HEAD }, REFUSAL);

    expect(steps).toEqual([`sh-no-reviewer-hold:${HEAD}`]);
  });
});
