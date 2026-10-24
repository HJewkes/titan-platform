import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import type { StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Outcome } from "../console-action/outcome.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { LAND_WORKFLOW } from "../registry.js";
import { callCommand, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import { loopAt, type LoopState } from "./loop-approval.js";
import { mergeAtHead } from "./merge-at-head.js";
import { standingAnswers, sweepStandingAnswers, type StandingAnswers } from "./standing-answers.js";

const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const NOW_MS = Date.parse("2026-10-18T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const PROOF_ACTOR = `owner-remote:titan-console proof ${CONFIRM}`;

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  fixture: ShepherdFixture;
  host: FactoryHost;
  answers: StandingAnswers;
  pr: number;
  runId: string;
  gateId: string;
  told: OwnerItemDeposit[];
  tap(waitFor?: "adversary-loop"): Promise<Outcome>;
  sweep(loop: LoopState, at?: number): ReturnType<typeof sweepStandingAnswers>;
}

/** A Shepherd run pending on approve-merge at H, then held g10-adversary as a seat would hold it. */
async function heldWorld(holdReason: string | null = "g10-adversary: synthetic authority change"): Promise<World> {
  const fixture = shepherdFixture();
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const dir = mkdtempSync(join(tmpdir(), "factory-loop-approval-"));
  dirs.push(dir);
  const answers = standingAnswers(dir);
  const { number: pr } = fixture.fake.addPr({ headSha: H });
  const services = fixture.routes.shepherd!;
  const registered = await callCommand<{ runId: string }>(host, fixture.routes, "shepherd.register", { repo: REPO, pr, task: "demo/T-1", implementer: "impl-a" });
  if (!registered.ok) throw new Error(registered.error);
  const { runId } = registered.data;
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(host.gates.get(gateId)?.status).toBe("pending"));
  if (holdReason !== null) services.store.get().hold(runId, holdReason, undefined, { actor: "seat" });
  const told: OwnerItemDeposit[] = [];
  const tell = async (deposit: OwnerItemDeposit) => void told.push(deposit);
  return {
    ...{ fixture, host, answers, pr, runId, gateId, told },
    tap: (waitFor = "adversary-loop") => mergeAtHead("act-1", { op: { kind: "merge-at-head", repo: REPO, pr, headSha: H, waitFor }, confirmEvent: CONFIRM }, { host, port: services.port, services, answers, now: () => NOW_MS }),
    sweep: (loop, at = NOW_MS) => sweepStandingAnswers(host, services, answers, new Date(at), { tell, loopRead: () => loop }),
  };
}

const landRuns = (host: FactoryHost) => host.runtime.list(["running", "paused", "completed", "failed", "cancelled"]).filter((run) => run.workflowName === LAND_WORKFLOW);
const releases = (w: World) => w.fixture.routes.shepherd!.store.get().eventsOf(w.runId).filter((event) => event.kind === "release");

describe("merge-at-head waiting out a g10 hold: the approval", () => {
  it("stands on the held Shepherd run, starts no land-pr, and its replay reads already", async () => {
    const w = await heldWorld();

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "approved", runId: w.runId });
    expect(await w.tap()).toEqual({ outcome: "already", runId: w.runId });
    expect(landRuns(w.host)).toEqual([]);
    expect(w.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("is refused on a PR with no g10 hold, which the plain merge-at-head serves", async () => {
    const w = await heldWorld(null);

    expect(await w.tap()).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("no g10 hold") });
  });

  it("leaves the hold and the gate alone while the adversary loop is still open", async () => {
    const w = await heldWorld();
    await w.tap();

    const swept = await w.sweep({ state: "open" });

    expect(swept).toEqual([{ kind: "pending", actionId: "act-1", runId: w.runId, reason: `the adversary loop has not closed at ${H}` }]);
    expect(w.fixture.routes.shepherd!.store.get().byRun(w.runId)?.held).toBe(true);
    expect(w.fixture.fake.effects.merge).toBe(0);
  });
});

describe("merge-at-head waiting out a g10 hold: the loop closes MERGE at the approved head", () => {
  it("lifts the g10 hold as the owner with this tap's proof, then answers the run's approve-merge and the PR merges", async () => {
    const w = await heldWorld();
    await w.tap();

    const lifted = await w.sweep({ state: "merge" });
    const answered = await w.sweep({ state: "merge" });

    await vi.waitFor(() => expect(w.fixture.fake.effects.merge).toBe(1));
    expect(lifted).toEqual([{ kind: "released", actionId: "act-1", runId: w.runId, holdClass: "g10-adversary" }]);
    expect(releases(w)).toEqual([expect.objectContaining({ actor: PROOF_ACTOR, headSha: H })]);
    expect(answered).toEqual([{ kind: "resolved", actionId: "act-1", runId: w.runId, gateId: w.gateId }]);
    expect(w.host.gates.get(w.gateId)?.resolvedBy).toMatchObject({ class: "owner-remote", id: "titan-console", confirmEvent: CONFIRM });
    expect(w.told).toEqual([]);
  });
});

describe("merge-at-head waiting out a g10 hold: a void", () => {
  it("on a new head voids the approval, tells the owner once, lifts nothing and merges nothing", async () => {
    const w = await heldWorld();
    await w.tap();
    w.fixture.fake.onGetPr = (pull) => void (pull.headSha = H2);

    const swept = await w.sweep({ state: "merge" });
    const again = await w.sweep({ state: "merge" });

    expect(swept).toEqual([{ kind: "voided", actionId: "act-1", runId: w.runId, reason: expect.stringContaining(`new head ${H2.slice(0, 7)}`) }]);
    expect(again).toEqual([]);
    expect(w.told).toEqual([expect.objectContaining({ depositId: "merge-approval-void-act-1", summary: `Merge approval voided: ${REPO}#${w.pr}`, context: expect.stringContaining("new head") })]);
    expect(releases(w)).toEqual([]);
    expect(w.fixture.fake.effects.merge).toBe(0);
    expect(await w.tap()).toMatchObject({ outcome: "gone", reason: expect.stringContaining("voided") });
  });

  it("on a non-MERGE close of the loop voids the approval and tells the owner why", async () => {
    const w = await heldWorld();
    await w.tap();

    const swept = await w.sweep({ state: "fix-first", stepId: `sh-review-panel:${H}` });

    expect(swept).toEqual([{ kind: "voided", actionId: "act-1", runId: w.runId, reason: expect.stringContaining("FIX_FIRST") }]);
    expect(w.told).toEqual([expect.objectContaining({ context: expect.stringContaining("closed without a MERGE") })]);
    expect(w.fixture.routes.shepherd!.store.get().byRun(w.runId)?.held).toBe(true);
    expect(w.fixture.fake.effects.merge).toBe(0);
  });

  it("on expiry voids the approval before the loop closes", async () => {
    const w = await heldWorld();
    await w.tap();

    const swept = await w.sweep({ state: "merge" }, NOW_MS + DAY_MS);

    expect(swept).toEqual([expect.objectContaining({ kind: "voided", reason: expect.stringContaining("expired") })]);
    expect(releases(w)).toEqual([]);
  });

  it("stays voided when the notice cannot be filed, and says so", async () => {
    const w = await heldWorld();
    await w.tap();
    const services = w.fixture.routes.shepherd!;
    const failing = async () => Promise.reject(new Error("spool is read-only"));

    const swept = await sweepStandingAnswers(w.host, services, w.answers, new Date(NOW_MS), { tell: failing, loopRead: () => ({ state: "fix-first", stepId: `sh-review-panel:${H}` }) });
    const again = await w.sweep({ state: "merge" });

    expect(swept).toEqual([expect.objectContaining({ kind: "voided", reason: expect.stringContaining("spool is read-only") })]);
    expect(again).toEqual([]);
  });
});

const result = (stepId: string, payload: Record<string, unknown>): StepResult => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-18T12:00:00.000Z", data: { result: payload } });
const runOf = (...results: StepResult[]) => ({ stepResults: Object.fromEntries(results.map((each) => [each.stepId, each])) });

describe("loopAt reads the adversary loop at one head", () => {
  it("is open with no record at the head", () => {
    expect(loopAt(runOf(), H)).toEqual({ state: "open" });
  });

  it("closes MERGE once Shepherd's g10 release judged the hold met at the head, released or in shadow", () => {
    expect(loopAt(runOf(result(`sh-g10-release:${H}:0`, { released: false, wouldRelease: true })), H)).toEqual({ state: "merge" });
    expect(loopAt(runOf(result(`sh-g10-release:${H}:1`, { released: true })), H)).toEqual({ state: "merge" });
  });

  it("stays open on a release judged at another head or judged unmet", () => {
    expect(loopAt(runOf(result(`sh-g10-release:${H2}:0`, { wouldRelease: true })), H)).toEqual({ state: "open" });
    expect(loopAt(runOf(result(`sh-g10-release:${H}:0`, { released: false })), H)).toEqual({ state: "open" });
  });

  it("closes non-MERGE on the panel's or the correctness reviewer's FIX_FIRST at the head, even beside a release", () => {
    const panel = result(`sh-review-panel:${H}`, { outcome: "FIX_FIRST" });
    const correctness = result(`sh-await-verdict:${H}`, { kind: "verdict", verdict: "FIX_FIRST" });

    expect(loopAt(runOf(result(`sh-g10-release:${H}:0`, { wouldRelease: true }), panel), H)).toEqual({ state: "fix-first", stepId: panel.stepId });
    expect(loopAt(runOf(correctness), H)).toEqual({ state: "fix-first", stepId: correctness.stepId });
  });

  it("ignores a FIX_FIRST at another head", () => {
    expect(loopAt(runOf(result(`sh-review-panel:${H2}`, { outcome: "FIX_FIRST" })), H)).toEqual({ state: "open" });
  });
});
