import { DispatchTimeoutError } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { WAIT_DEMOTIONS } from "./freeze-wait.js";
import { G10_RELEASE_STEP } from "./g10-release.js";
import type { ShepherdPhases, Verdict, WakeOutcome, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const H2 = fakeSha("held-fix");
/** Would merge on its own, so only the hold keeps a reviewed head unmerged. */
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "demo-seat" };
const G10_REVIEW = "g10-review: 512 changed lines";
const G10_ADVERSARY = "g10-adversary: packages/tool-guard touch";
const VISUAL = "visual-gate2: the owner reviews the contrast baseline";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Held {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
  wakes: WakeRequest[];
  /** Whether the run was held as each wake went out. */
  heldAtWake: boolean[];
  reviewed: string[];
  sent: string[];
}

interface HeldOptions {
  heldRepair?: "off" | "on";
  holds?: Array<[string, string?]>;
  review?: (headSha: string, fake: FakeGitHub) => Verdict;
  send?: ExitNoticePorts["send"];
  mergeableState?: "clean" | "dirty";
  /** Whether a head's checks pass; absent means H1 red and every pushed head green. */
  passes?: (headSha: string) => boolean;
}

const merge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });

/** Every taken wake pushes H2 and clears a conflict, as a fixer's push does. */
function heldRun(options: HeldOptions = {}): Held {
  const fake = fakeGitHub();
  const passes = options.passes ?? ((headSha: string) => headSha !== H1);
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, passes(pr.headSha) ? "success" : "failure"), successRun("dag-check", 2)]);
  const [wakes, heldAtWake, reviewed, sent]: [WakeRequest[], boolean[], string[], string[]] = [[], [], [], []];
  const ref = shepherdStoreRef();
  const fix = (request: WakeRequest, runId: string): WakeOutcome => {
    wakes.push(request);
    heldAtWake.push(ref.get().byRun(runId)?.held ?? false);
    fake.pr(1).mergeableState = "clean";
    fake.pushHead(1, H2);
    return { kind: "woken", agent: "impl-a" };
  };
  const shepherd: ShepherdPhases = {
    wake: async (ctx, request) => fix(request, ctx.runId),
    review: async (_ctx, request) => (reviewed.push(request.headSha), (options.review ?? merge)(request.headSha, fake)),
  };
  const ports: ExitNoticePorts = { seatFor: () => "book-seat", lastReport: async () => undefined, send: options.send ?? (async (_seat, text) => void sent.push(text)) };
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice: ports, park: async () => ({ lines: [] }), ...(options.heldRepair && { heldRepair: options.heldRepair }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(shepherd)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge"), mergeableState: options.mergeableState ?? "clean" });
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  for (const [reason, reviewer] of options.holds ?? [[G10_REVIEW]]) store.hold(runId, reason, reviewer);
  return { host, fake, store, runId, wakes, heldAtWake, reviewed, sent };
}

const currentStep = (w: Held): string => w.host.runtime.status(w.runId)?.currentStep ?? "";
const stepIds = (w: Held): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);
const ticksPast = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function restsAt(w: Held, step: RegExp): Promise<void> {
  await vi.waitFor(() => expect(currentStep(w)).toMatch(step), { timeout: 5_000 });
  await ticksPast(200);
}

describe("under heldRepair on, a g10 hold gates the merge and not the repair (decision 423(1))", () => {
  // The MERGE here carries no merge facts, so approve-merge opens only as it did before no-facts waited at its head (TP-3734 r3b).
  beforeEach(() => void (WAIT_DEMOTIONS.noFacts = false));
  afterEach(() => void (WAIT_DEMOTIONS.noFacts = true));

  it("a red held head wakes exactly one ci-red fixer, and the fixed head is reviewed but not merged while held, even when approved", async () => {
    const w = heldRun({ heldRepair: "on" });
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    w.host.runtime.signal(w.runId, "approve-merge", { decision: "merge", headSha: H2 }, OWNER);
    await restsAt(w, /^merge/);

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(w.reviewed).toEqual([H2]);
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_REVIEW });
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("a held head that conflicts and was never green wakes exactly one conflict fixer", async () => {
    const w = heldRun({ heldRepair: "on", mergeableState: "dirty", passes: () => true });

    await vi.waitFor(() => expect(w.reviewed).toContain(H2), { timeout: 5_000 });

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("a held FIX_FIRST wakes the fixer with the reviewer's findings, and the fixed head is reviewed again", async () => {
    const fixFirst = (headSha: string): Verdict => (headSha === H1 ? { kind: "FIX_FIRST", headSha, text: "the parser test misses nested input" } : merge(headSha));
    const w = heldRun({ heldRepair: "on", holds: [[G10_ADVERSARY]], review: fixFirst, passes: () => true });

    await vi.waitFor(() => expect(w.reviewed).toEqual([H1, H2]), { timeout: 5_000 });

    expect(w.wakes).toEqual([expect.objectContaining({ kind: "review", headSha: H1, payload: expect.objectContaining({ text: "the parser test misses nested input" }) })]);
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_ADVERSARY });
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("a held NO_REPRO wakes the fix-proof brief", async () => {
    const noRepro = (headSha: string): Verdict => (headSha === H1 ? { kind: "NO_REPRO", headSha, result: { verdict: "vacuous" } } : merge(headSha));
    const w = heldRun({ heldRepair: "on", holds: [[G10_ADVERSARY]], review: noRepro, passes: () => true });

    await vi.waitFor(() => expect(w.wakes).toHaveLength(1), { timeout: 5_000 });

    expect(w.wakes[0]).toMatchObject({ kind: "fix-proof", headSha: H1 });
  });

  it.each([
    ["a visual-gate hold", [[VISUAL]]],
    ["a g10 hold that names its reviewer", [[G10_REVIEW, "rv-named"]]],
    ["an owner hold over a g10 hold", [[G10_REVIEW], ["owner-asked: the owner reads it first"]]],
    ["a visual hold parked under a g10-adversary hold", [[VISUAL], [G10_ADVERSARY]]],
  ] as Array<[string, Array<[string, string?]>]>)("%s still wakes no fixer and waits", async (_case, holds) => {
    const w = heldRun({ heldRepair: "on", holds });

    await restsAt(w, /^sh-held-wait/);

    expect(w.wakes).toEqual([]);
    expect(w.fake.pr(1).headSha).toBe(H1);
  });

  it("with the flag off a g10 hold keeps today's wait: no fixer, one seat notice", async () => {
    const w = heldRun({ heldRepair: "off" });

    await restsAt(w, /^sh-held-wait/);

    expect(w.wakes).toEqual([]);
    expect(w.sent).toHaveLength(1);
  });
});

/** An opus reviewer's MERGE written at the head, as the g10 release reads one. */
const opusMerge = (headSha: string): Verdict => ({
  kind: "MERGE",
  headSha,
  reviewerProfile: "bd-reviewer",
  evidence: { record: { head: headSha, verdictLocator: { source: { conversation: { nativeId: "s-1" } } }, reviewer: { agentId: "a-1", sessionId: "s-1" } } },
});

describe("a MERGE at a green head releases its g10-review hold before a conflict leaves the round (TP-3198, cause E)", () => {
  it("records the release, then wakes the conflict fixer on the released run", async () => {
    const conflictsAfterReview = (headSha: string, fake: FakeGitHub): Verdict => (headSha === H1 && (fake.pr(1).mergeableState = "dirty"), opusMerge(headSha));
    const w = heldRun({ review: conflictsAfterReview, passes: () => true });

    await vi.waitFor(() => expect(w.wakes).toHaveLength(1), { timeout: 5_000 });

    expect(w.wakes[0]).toMatchObject({ kind: "conflict", headSha: H1 });
    expect(w.heldAtWake).toEqual([false]);
    expect(stepIds(w)).toContain(`${G10_RELEASE_STEP}:${H1}:0`);
  });
});

describe("a seat notice the broker timed out is sent again after a backoff (F1)", () => {
  it("a held notice whose first send timed out reaches the seat", async () => {
    const delivered: string[] = [];
    let attempts = 0;
    const flaky: ExitNoticePorts["send"] = async (_seat, text) => {
      if (attempts++ === 0) throw new DispatchTimeoutError("agent-chat message timed out");
      delivered.push(text);
    };
    const w = heldRun({ holds: [[VISUAL]], send: flaky });

    await restsAt(w, /^sh-held-wait/);

    expect(attempts).toBe(2);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(VISUAL);
  });
});
