import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { clearReviewWait, noteReviewWait } from "./review-wait.js";
import { spawnGate } from "./spawn-gate.js";
import type { Registration } from "./store.js";
import { SHEPHERD_STEPS } from "./pr.js";
import { PhaseSchema, PrTimelineSchema, TimelineEntrySchema, stepPhase, timelineEntries, watchRow } from "./view.js";

const registration = { repo: "acme/widgets", pr: 1, branch: "feat/x", runId: "run-1", task: "demo/T-1", held: false } as unknown as Registration;

function pausedAt(currentStep: string): WorkflowRun {
  return {
    id: "run-1",
    workflowName: "shepherd",
    params: { pr: "1" },
    status: "paused",
    currentStep,
    stepResults: {},
    activeSteps: {},
    revision: 1,
    ownerGeneration: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
  };
}

function completedWith(stepId: string, result: object): WorkflowRun {
  const stepResult = { stepId, iteration: 0, completedAt: "2026-01-01T01:00:00.000Z", signal: null, data: { result } };
  return { ...pausedAt(stepId), status: "completed", currentStep: null, completedAt: "2026-01-01T01:00:00.000Z", stepResults: { [stepId]: stepResult } } as unknown as WorkflowRun;
}

describe("shepherd view outcomes", () => {
  it("reads a completed run that stopped on a closed PR as stopped, not merged", () => {
    const row = watchRow({ registration, run: completedWith("sh-stopped", { kind: "stopped", reason: "closed", headSha: "abc1234" }) });

    expect(row).toMatchObject({ phase: "done", outcome: { kind: "stopped", reason: "closed" } });
  });

  it("reads a completed run that passed sh-landed as merged", () => {
    expect(watchRow({ registration, run: completedWith("sh-landed", { mergeSha: "def5678" }) }).outcome).toEqual({ kind: "merged", reason: null });
  });

  it("leaves the outcome unknown for a completed run with neither record", () => {
    expect(watchRow({ registration, run: completedWith("merge", {}) }).outcome).toBeNull();
  });
});

describe("shepherd view phases", () => {
  it.each(["sh-review-intent:abc1234", "sh-merge-evidence:abc1234"])("reads a run paused at %s as review", (step) => {
    expect(watchRow({ registration, run: pausedAt(step) }).phase).toBe("review");
  });

  it("keeps the review steps in the review phase", () => {
    expect(stepPhase("sh-review:abc1234")).toBe("review");
  });

  it("names the wait a review step has noted in place of the plain review wait, and drops it once cleared", () => {
    const run = pausedAt("sh-review:abc1234");
    noteReviewWait("acme/widgets", 1, "waiting for reviewer admission (the broker has not started rv-1): machine guard: full");

    const noted = watchRow({ registration, run }).nextAction;
    clearReviewWait("acme/widgets", 1);

    expect(noted).toBe("waiting for reviewer admission (the broker has not started rv-1): machine guard: full");
    expect(watchRow({ registration, run }).nextAction).toBe("waiting for the review");
  });

  it("names the place in the spawn gate's queue of a review the gate keeps waiting", () => {
    const run = pausedAt("sh-review:abc1234");
    const gate = spawnGate({ read: () => ({ load5: 21 }), now: () => 1_000, log: () => undefined });
    const ask = (name: string, pr: number, fixer: boolean) => expect(() => gate.admit(name, [], { fixer, target: { repo: "acme/widgets", pr } })).toThrow();
    ask("rv-0", 0, false);
    ask("rv-1", 1, false);
    ask("rv-2", 2, true);
    noteReviewWait("acme/widgets", 1, "waiting for reviewer admission (the broker has not started rv-1): ReviewerBrokerBusy; asking again in 1 min");

    const noted = watchRow({ registration, run }).nextAction;
    clearReviewWait("acme/widgets", 1);

    expect(noted).toBe("waiting for reviewer admission (the broker has not started rv-1): ReviewerBrokerBusy; asking again in 1 min; waiting for a spawn slot, position 3 of 3");
  });
});

describe("shepherd view holds", () => {
  it("names the head and the session whose MERGE satisfied a hold", () => {
    const by = { reviewer: "rv-sec", agentId: "agent-rv", sessionId: "session-rv", locator: {} };
    const held = { ...registration, held: true, holdReason: "awaiting a named review", holdSatisfied: { head: "a".repeat(40), by } } as Registration;

    const row = watchRow({ registration: held, run: pausedAt("merge:0:0") });

    expect(row.held).toEqual({ reason: "awaiting a named review", satisfiedAt: "a".repeat(40), satisfiedBy: "rv-sec (agent-rv/session-rv)" });
  });

  it("shows an unsatisfied hold by its reason alone", () => {
    const held = { ...registration, held: true, holdReason: "owner review", holdSatisfied: null } as Registration;

    expect(watchRow({ registration: held, run: pausedAt("merge:0:0") }).held).toEqual({ reason: "owner review" });
  });
});

describe("a run held at registration waiting in its merge step", () => {
  const H1 = "1".repeat(40);
  const H2 = "2".repeat(40);
  const waitedFrom = Date.parse("2026-01-01T00:10:00.000Z");
  const reason = "g10-review: +415/-0 diff over 400";
  const by = { reviewer: "seat-review", agentId: "agent-seat", sessionId: "session-seat", locator: {} };
  const held = { ...registration, held: true, holdReason: reason, holdReviewer: "seat-review", holdSatisfied: null } as Registration;

  /** Shepherd's own reviewer sent MERGE at `head`, the policy allowed it, and the run has sat in `merge` ever since. */
  function mergingAt(head: string): WorkflowRun {
    const run = { ...pausedAt("merge:0"), status: "running" } as WorkflowRun;
    const record = (stepId: string, at: number, result: object) => {
      run.stepResults[stepId] = { stepId, iteration: 0, agentId: null, signal: null, completedAt: new Date(at).toISOString(), data: { result } };
    };
    record(`sh-await-verdict:${head}`, waitedFrom - 2000, { kind: "verdict", verdict: "MERGE", head, locator: {}, reviewer: { agentId: "agent-rv-own" } });
    record("merge-policy:0", waitedFrom - 1000, { outcome: "allow", headSha: head });
    record("ci-wait:1", waitedFrom, { verdict: "green", headSha: head });
    return run;
  }
  const twentyMinutesIn = new Date(waitedFrom + 20 * 60_000);

  it("keeps the merging phase, names the hold and its reviewer, and does not stall after 20 minutes", () => {
    const row = watchRow({ registration: held, run: mergingAt(H1), now: twentyMinutesIn });

    expect(row).toMatchObject({ phase: "merging", headSha: H1, held: { reason }, phaseSince: new Date(waitedFrom).toISOString(), stalled: null });
    expect(row.nextAction).toBe(`waiting for the hold to be released (${reason}), or for a MERGE from seat-review at ${H1.slice(0, 7)}`);
  });

  it("still waits on the hold when its reviewer has sent MERGE only at the fix round's newer head", () => {
    const satisfiedLater = { ...held, holdSatisfied: { head: H2, by } } as Registration;

    const row = watchRow({ registration: satisfiedLater, run: mergingAt(H1), now: twentyMinutesIn });

    expect(row).toMatchObject({ phase: "merging", stalled: null });
    expect(row.nextAction).toMatch(/^waiting for the hold to be released/);
  });

  it("merges, with its stall limit, once the hold is satisfied at the run's head", () => {
    const satisfied = { ...held, holdSatisfied: { head: H2, by } } as Registration;

    const row = watchRow({ registration: satisfied, run: mergingAt(H2), now: twentyMinutesIn });

    expect(row).toMatchObject({ phase: "merging", nextAction: "merging" });
    expect(row.stalled).toEqual({ reason: "20 min in merging, over the 15 min limit" });
  });

  it("still stalls an unheld run 20 minutes into its merge step", () => {
    const row = watchRow({ registration, run: mergingAt(H1), now: twentyMinutesIn });

    expect(row.stalled).toEqual({ reason: "20 min in merging, over the 15 min limit" });
  });

  it("emits only the phases agent-chat's burndown parses, which rejects the whole status array on any other (CC-791)", () => {
    expect(PhaseSchema.options).toEqual(["awaiting-pr", "ci", "fixing", "review", "awaiting-approval", "merging", "post-merge", "done", "failed", "cancelled"]);
  });

  it("names a hold with no reviewer by its reason alone", () => {
    const owner = { ...held, holdReviewer: null } as Registration;

    expect(watchRow({ registration: owner, run: mergingAt(H1), now: twentyMinutesIn }).nextAction).toBe(`waiting for the hold to be released (${reason})`);
  });
});

describe("shepherd view stalls", () => {
  function reviewedRun(outcomes: readonly ("started" | "not-started")[]): WorkflowRun {
    const run = pausedAt("sh-review:abc1234");
    outcomes.forEach((outcome, iteration) => {
      const data = outcome === "started" ? { kind: "dispatched" } : { kind: "none", notStarted: true };
      const completedAt = `2026-01-01T00:00:0${iteration}.000Z`;
      run.stepResults[`sh-review:abc1234#${iteration}`] = { stepId: "sh-review:abc1234", iteration, agentId: null, signal: null, completedAt, data };
    });
    return run;
  }

  it("reads a run as stalled after three review dispatches in a row that started no reviewer, and not after two", () => {
    const now = new Date("2026-01-01T00:01:00.000Z");
    const two = watchRow({ registration, run: reviewedRun(["started", "not-started", "not-started"]), now });
    const three = watchRow({ registration, run: reviewedRun(["not-started", "started", "not-started", "not-started", "not-started"]), now });

    expect(two.stalled).toBeNull();
    expect(three.stalled).toEqual({ reason: "3 review dispatches in a row started no reviewer" });
    expect(three.phase).toBe("review");
  });

  describe("time in phase", () => {
    const minutes = (n: number) => n * 60_000;
    const started = Date.parse("2026-01-01T00:00:00.000Z");

    /** A run that began long before the current phase: sh-await-pr done at 2026-03-01, now parked in ci-wait. */
    function inCiSince(): WorkflowRun {
      const run = pausedAt("ci-wait");
      run.stepResults["sh-await-pr"] = { stepId: "sh-await-pr", iteration: 0, agentId: null, signal: null, completedAt: "2026-03-01T00:00:00.000Z", data: {} };
      return run;
    }
    const phaseStart = Date.parse("2026-03-01T00:00:00.000Z");

    it("reads a ci run as stalled at 61 minutes in the phase and not at 59, however old the run is", () => {
      const at59 = watchRow({ registration, run: inCiSince(), now: new Date(phaseStart + minutes(59)) });
      const at61 = watchRow({ registration, run: inCiSince(), now: new Date(phaseStart + minutes(61)) });

      expect(at59.stalled).toBeNull();
      expect(at61.stalled).not.toBeNull();
    });

    it("does not stall a run parked on approve-merge for three days, and names the owner", () => {
      const run = pausedAt("approve-merge");
      const gate = { id: "run-1/approve-merge", createdAt: "2026-01-01T00:00:00.000Z" } as never;

      const row = watchRow({ registration, run, pending: { gate, stepId: "approve-merge" }, now: new Date(started + minutes(3 * 24 * 60)) });

      expect(row.stalled).toBeNull();
      expect(row.nextAction).toBe("owner: resolve approve-merge");
    });

    it("keeps a malformed sh-wake step as a plain step entry instead of throwing", () => {
      const run = pausedAt("sh-wake-implementer:0");
      run.stepResults["sh-wake-implementer:0#0"] = { stepId: "sh-wake-implementer:0", iteration: 0, agentId: null, signal: null, completedAt: "2026-01-01T00:00:01.000Z", data: { request: 42, outcome: [] } };

      const entries = timelineEntries(run, []);

      expect(entries).toEqual([expect.objectContaining({ kind: "step", stepId: "sh-wake-implementer:0" })]);
    });

    it.each(["sh-wake-implementer:0", "sh-wake-fix-first:0", "sh-repair:0"])("reads a run at %s as fixing", (step) => {
      expect(watchRow({ registration, run: pausedAt(step) }).phase).toBe("fixing");
    });

    it("gives every declared Shepherd step id an explicit phase, never the ci fallback", () => {
      const unmapped = SHEPHERD_STEPS.map((declared) => declared.id).filter((id) => stepPhase(id) === "ci" && !["land-rules", "ci-wait", "update-branch", "update-backoff", "rerun", "sh-freeze-hold", "sh-freeze-wait"].includes(id));

      expect(unmapped).toEqual([]);
    });

    it("maps an unknown step prefix to ci instead of throwing", () => {
      expect(() => stepPhase("sh-brand-new:abc1234")).not.toThrow();
      expect(stepPhase("sh-brand-new:abc1234")).toBe("ci");
    });
  });
});

describe("shepherd timeline verdict and wake entries", () => {
  const H1 = "1".repeat(40);
  const H2 = "2".repeat(40);
  const reviewer = { agentId: "rev-1", sessionId: "s-1" };
  const locator = { source: { path: "sessions/rev.jsonl" }, evidence: { line: { byteOffset: 100, byteLength: 20 } }, selector: { kind: "subrecord-text", path: [] } };

  function withResults(results: readonly { stepId: string; iteration?: number; at: string; result: unknown }[]): WorkflowRun {
    const run = pausedAt("sh-await-verdict");
    for (const { stepId, iteration = 0, at, result } of results) {
      run.stepResults[`${stepId}#${iteration}`] = { stepId, iteration, agentId: null, signal: null, completedAt: at, data: { result } };
    }
    return run;
  }

  it("gives one verdict entry per sh-await-verdict result, in time order with each head", () => {
    const run = withResults([
      { stepId: `sh-await-verdict:${H2}`, at: "2026-01-01T00:03:00.000Z", result: { kind: "verdict", verdict: "MERGE", head: H2, locator, reviewer } },
      { stepId: `sh-await-verdict:${H1}`, at: "2026-01-01T00:01:00.000Z", result: { kind: "verdict", verdict: "FIX_FIRST", head: H1, locator, reviewer, text: "fix" } },
      { stepId: `sh-await-verdict:${H1}`, iteration: 1, at: "2026-01-01T00:02:00.000Z", result: { kind: "verdict", verdict: "FIX_FIRST", head: H1, locator, reviewer, text: "fix" } },
    ]);

    const entries = timelineEntries(run, []);

    expect(entries.map((entry) => entry.kind === "verdict" && [entry.verdict, entry.headSha])).toEqual([
      ["FIX_FIRST", H1],
      ["FIX_FIRST", H1],
      ["MERGE", H2],
    ]);
    expect(entries[2]).toEqual({ kind: "verdict", stepId: `sh-await-verdict:${H2}`, verdict: "MERGE", headSha: H2, locator: { path: "sessions/rev.jsonl", start: 100, end: 120 }, reviewer: "rev-1" });
  });

  it("maps a wait that ended without a verdict to verdict none with no head", () => {
    const run = withResults([{ stepId: `sh-await-verdict:${H1}`, at: "2026-01-01T00:01:00.000Z", result: { kind: "none", reason: "wait" } }]);

    expect(timelineEntries(run, [])).toEqual([{ kind: "verdict", stepId: `sh-await-verdict:${H1}`, verdict: "none", headSha: null, locator: null, reviewer: null }]);
  });

  it("leaves the locator null when the verdict's locator lacks a transcript span", () => {
    const run = withResults([{ stepId: `sh-await-verdict:${H1}`, at: "2026-01-01T00:01:00.000Z", result: { kind: "verdict", verdict: "MERGE", head: H1, locator: {}, reviewer } }]);

    expect(timelineEntries(run, [])).toEqual([expect.objectContaining({ kind: "verdict", locator: null, reviewer: "rev-1" })]);
  });

  it("keeps an unparseable sh-await-verdict result as a plain step entry", () => {
    const run = withResults([{ stepId: `sh-await-verdict:${H1}`, at: "2026-01-01T00:01:00.000Z", result: { kind: "verdict", verdict: "MAYBE" } }]);

    expect(timelineEntries(run, [])).toEqual([expect.objectContaining({ kind: "step", stepId: `sh-await-verdict:${H1}` })]);
  });

  it("gives a wake entry for an implementer wake and for a FIX_FIRST wake record", () => {
    const run = withResults([
      { stepId: "sh-wake-fix-first", at: "2026-01-01T00:01:00.000Z", result: { repo: "acme/widgets", pr: 1, headSha: H1, fixFirst: 1 } },
      { stepId: "sh-wake-implementer:0", at: "2026-01-01T00:02:00.000Z", result: { kind: "woken", agent: "impl-1", mode: "resume", sessionId: "s-9" } },
      { stepId: "sh-wake-implementer:1", at: "2026-01-01T00:03:00.000Z", result: { kind: "unhandled", reason: "seat grants no fixer" } },
    ]);

    expect(timelineEntries(run, [])).toEqual([
      { kind: "wake", stepId: "sh-wake-fix-first", request: "review", outcome: null, agent: null, mode: null, sessionId: null },
      { kind: "wake", stepId: "sh-wake-implementer:0", request: null, outcome: "woken", agent: "impl-1", mode: "resume", sessionId: "s-9" },
      { kind: "wake", stepId: "sh-wake-implementer:1", request: null, outcome: "unhandled", agent: null, mode: null, sessionId: null },
    ]);
  });

  it("names the refusal on a held wake's entry, and as the next action while the run waits for a new head", () => {
    const refusal = "agent-chat refused to start the successor impl-1-s1: DispatchError";
    const run = withResults([
      { stepId: "sh-wake-implementer:0", at: "2026-01-01T00:02:00.000Z", result: { kind: "unhandled", reason: refusal, held: { agent: "impl-1-s1" } } },
      { stepId: "sh-exit-notice", at: "2026-01-01T00:02:01.000Z", result: { sent: true, cause: "held", detail: refusal, seat: "demo-coord" } },
    ]);
    run.currentStep = "await-new-head:0";

    const [entry] = timelineEntries(run, []);

    expect(entry).toEqual({ kind: "wake", stepId: "sh-wake-implementer:0", request: null, outcome: "unhandled", agent: null, mode: null, sessionId: null, held: refusal });
    expect(TimelineEntrySchema.parse(entry)).toEqual(entry);
    expect(watchRow({ registration, run }).nextAction).toBe(`no fixer could start (${refusal}); the seat was told, waiting for a new head`);
  });

  it("does not count a notice sent before the held wake as telling the seat about it", () => {
    const refusal = "agent-chat refused to start the successor impl-1-s2: DispatchError";
    const run = withResults([
      { stepId: "sh-exit-notice", at: "2026-01-01T00:01:00.000Z", result: { sent: true, cause: "unread", detail: "earlier exit", seat: "demo-coord" } },
      { stepId: "sh-wake-implementer:1", at: "2026-01-01T00:02:00.000Z", result: { kind: "unhandled", reason: refusal, held: { agent: "impl-1-s2" } } },
      { stepId: "sh-exit-notice", iteration: 1, at: "2026-01-01T00:02:01.000Z", result: { sent: false, cause: "held", detail: "the seat notice failed: Error" } },
    ]);
    run.currentStep = "await-new-head:1";

    expect(watchRow({ registration, run }).nextAction).toBe(`no fixer could start (${refusal}), waiting for a new head`);
  });

  it("emits entries that the timeline schema accepts", () => {
    const run = withResults([
      { stepId: `sh-await-verdict:${H1}`, at: "2026-01-01T00:01:00.000Z", result: { kind: "verdict", verdict: "MERGE", head: H1, locator, reviewer } },
      { stepId: "sh-wake-implementer:0", at: "2026-01-01T00:02:00.000Z", result: { kind: "woken", agent: "impl-1", mode: "live", sessionId: "s-9" } },
    ]);

    for (const entry of timelineEntries(run, [])) expect(TimelineEntrySchema.parse(entry)).toEqual(entry);
  });

  it("parses live and fix-proof wakes through the timeline schema", () => {
    const run = withResults([
      { stepId: "sh-wake-implementer:0", at: "2026-01-01T00:02:00.000Z", result: { kind: "woken", agent: "impl-1", mode: "live", sessionId: "s-9" } },
      { stepId: "sh-wake-implementer:1", at: "2026-01-01T00:03:00.000Z", result: { kind: "woken", agent: "impl-1", mode: "successor", sessionId: "s-10" } },
    ]);
    const entries = timelineEntries(run, []);
    const timeline = { row: watchRow({ registration, run }), entries: [...entries, { ...entries[0], request: "fix-proof" }] };

    expect(PrTimelineSchema.parse(timeline).entries.map((e) => e.kind === "wake" && [e.request, e.mode])).toEqual([[null, "live"], [null, "successor"], ["fix-proof", "live"]]);
  });
});
