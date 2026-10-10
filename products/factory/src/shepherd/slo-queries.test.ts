import type { GateRecord } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { ShepherdEvent } from "./events.js";
import { SLO_QUERIES, type SloInput } from "./slo-queries.js";

const REPO = "acme/widgets";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-10-07T10:00:00Z");
const NOW = Date.parse("2026-10-08T12:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();

function run(id: string, steps: [string, number, Record<string, unknown>][], extra: Partial<WorkflowRun> = {}): WorkflowRun {
  const stepResults = Object.fromEntries(steps.map(([key, at, result]) => [key, { stepId: key.split(":")[0]!, iteration: 0, agentId: null, signal: null, completedAt: iso(at), data: { result } }]));
  return { id, workflowName: "shepherd-pr", params: { repo: REPO, pr: "7" }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(T0), completedAt: null, error: null, ...extra };
}

function gate(id: string, opened: number, extra: Partial<GateRecord> = {}): GateRecord {
  return { id, prompt: "p", schema: undefined, status: "pending", payload: undefined, reason: undefined, createdAt: iso(opened), resolvedAt: undefined, expiresAt: undefined, resolvedBy: undefined, resolvedEvidence: undefined, rule: undefined, summary: undefined, ...extra } as GateRecord;
}

const resolved = (id: string, opened: number, closed: number, cls: string): GateRecord =>
  gate(id, opened, { status: "resolved", resolvedAt: iso(closed), resolvedBy: { class: cls, id: "x", channel: "terminal" } as GateRecord["resolvedBy"] });

const event = (kind: ShepherdEvent["kind"], at: number, runId: string | null = null): ShepherdEvent => ({ runId, repo: REPO, pr: null, kind, reason: null, actor: null, at: iso(at), headSha: null });

const EMPTY_COST = { prs: [], weeks: [], totals: { prs: 0, completePrs: 0, usd: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, unreadable: 0, p50Usd: null, p90Usd: null } };

function input(over: Partial<SloInput> = {}): SloInput {
  return { runs: [], gates: [], events: [], now: NOW, range: { from: "2026-10-07", to: "2026-10-08" }, cost: async () => EMPTY_COST, ...over };
}

/** Reviewer MERGE at T0 + 30m after a dispatch at T0 + 20m, merged at T0 + `mergeAfter` minutes. */
function merged(id: string, mergeAfter: number, more: [string, number, Record<string, unknown>][] = []): WorkflowRun {
  return run(id, [
    ["sh-review:h1", T0 + 20 * MINUTE, { kind: "dispatched" }],
    ["sh-await-verdict:h1", T0 + 30 * MINUTE, { kind: "verdict", verdict: "MERGE" }],
    ["merge:0", T0 + mergeAfter * MINUTE, { done: true }],
    ...more,
  ]);
}

const value = async (id: string, given: SloInput) => SLO_QUERIES[id]!(given);

describe("SLO queries over an empty ledger", () => {
  it("answer null for every share, mean and percentile, and a real zero only for counts and daily rates", async () => {
    const counts = ["availability.stuck-runs", "availability.freeze-hours-max", "quality.reverts", "owner-load.overdue-owner-gates"];
    const perDay = ["business.merges-per-day", "owner-load.touches-per-day"];
    const expected = (id: string) => (counts.includes(id) ? { value: 0, n: 0 } : perDay.includes(id) ? { value: 0, n: 2 } : { value: null, n: 0 });
    const results = await Promise.all(Object.keys(SLO_QUERIES).map(async (id) => [id, await value(id, input())] as const));

    for (const [id, result] of results) expect(result, id).toEqual(expected(id));
  });
});

describe("availability queries", () => {
  it("counts recovery_required runs and paused runs with no pending gate as stuck", async () => {
    const runs = [run("a", [], { status: "paused" }), run("b", [], { status: "paused" }), run("c", [], { status: "recovery_required" }), run("d", [])];

    expect(await value("availability.stuck-runs", input({ runs, gates: [gate("b/approve-merge:0", T0)] }))).toEqual({ value: 2, n: 4 });
  });

  it("gives the share of runs started in range that failed", async () => {
    const runs = [run("a", [], { status: "failed" }), run("b", []), run("c", []), run("d", [], { status: "failed", startedAt: "2026-09-01T00:00:00.000Z" })];

    expect(await value("availability.failed-share", input({ runs }))).toEqual({ value: 0.333, n: 3 });
  });

  it("takes the longest freeze episode, counting one still open to now", async () => {
    const events = [event("freeze", T0), event("thaw", T0 + HOUR), event("freeze", NOW - 3 * HOUR)];

    expect(await value("availability.freeze-hours-max", input({ events }))).toEqual({ value: 3, n: 2 });
  });
});

describe("flow queries", () => {
  it("measures register to first review dispatch and dispatch to verdict", async () => {
    const runs = [merged("a", 40)];

    expect(await value("flow.queued-p90", input({ runs }))).toEqual({ value: 20, n: 1 });
    expect(await value("flow.review-p90", input({ runs }))).toEqual({ value: 10, n: 1 });
  });

  it("measures MERGE to merged and register to merged per merged run", async () => {
    const runs = [merged("a", 40), merged("b", 90)];

    expect(await value("flow.merge-verdict-to-merged-p90", input({ runs }))).toEqual({ value: 60, n: 2 });
    expect(await value("flow.register-to-merged-p90", input({ runs }))).toEqual({ value: 90, n: 2 });
  });

  it("measures each hold to its release in hours", async () => {
    const events = [event("hold", T0, "a"), event("release", T0 + 2 * HOUR, "a"), event("hold", T0, "b"), event("release", T0 + 6 * HOUR, "b")];

    expect(await value("flow.hold-p90-hours", input({ events }))).toEqual({ value: 6, n: 2 });
  });

  it("measures the owner's approve-merge waits and ignores other gate kinds", async () => {
    const gates = [resolved("a/approve-merge:0", T0, T0 + 3 * HOUR, "owner-terminal"), resolved("b/ci-failed:0", T0, T0 + 9 * HOUR, "owner-terminal")];

    expect(await value("flow.merge-gate-wait-p90", input({ gates }))).toEqual({ value: 3, n: 1 });
  });

  it("gives the share of ended PRs merged outside Shepherd", async () => {
    const outside = run("o", [], { status: "cancelled", completedAt: iso(T0), error: `${REPO}#9 was merged outside Shepherd` });

    expect(await value("flow.outside-share", input({ runs: [merged("a", 40), outside] }))).toEqual({ value: 0.5, n: 2 });
  });

  it("averages merge-ups per merged run", async () => {
    const runs = [merged("a", 40, [["update-branch:0", T0 + MINUTE, {}], ["update-branch:1", T0 + 2 * MINUTE, {}]]), merged("b", 40)];

    expect(await value("flow.merge-ups-per-merge", input({ runs }))).toEqual({ value: 1, n: 2 });
  });

  it("counts re-reviews per first review and the superseded share, leaving out reviews of unknown cause", async () => {
    const intents: [string, number, Record<string, unknown>][] = [
      ["sh-review-intent:h1", T0, { kind: "intent", cause: { cause: "first" } }],
      ["sh-review-intent:h2", T0 + MINUTE, { kind: "intent", cause: { cause: "fix-round" } }],
      ["sh-review-intent:h3", T0 + 2 * MINUTE, { kind: "intent", cause: { cause: "superseded" } }],
      ["sh-review-intent:h4", T0 + 3 * MINUTE, { kind: "intent", cause: { cause: "unknown" } }],
    ];

    expect(await value("flow.rereviews-per-first-review", input({ runs: [merged("a", 40, intents), merged("b", 40)] }))).toEqual({ value: 2, n: 1 });
    expect(await value("cost.superseded-review-share", input({ runs: [merged("a", 40, intents)] }))).toEqual({ value: 0.333, n: 3 });
  });
});

describe("quality queries", () => {
  const fixFirst = (key: string, at: number): [string, number, Record<string, unknown>] => [key, at, { kind: "verdict", verdict: "FIX_FIRST" }];

  it("gives the FIX_FIRST share of verdicts and the no-verdict share of verdict waits", async () => {
    const runs = [merged("a", 40, [fixFirst("sh-await-verdict:h0", T0 + MINUTE), ["sh-await-verdict:h2", T0 + 2 * MINUTE, { kind: "none" }]])];

    expect(await value("quality.fix-first-rate", input({ runs }))).toEqual({ value: 0.5, n: 2 });
    expect(await value("quality.no-verdict-rate", input({ runs }))).toEqual({ value: 0.333, n: 3 });
  });

  it("takes the p90 of FIX_FIRST rounds per merged run", async () => {
    const runs = [merged("a", 40, [fixFirst("sh-await-verdict:h0", T0 + MINUTE), fixFirst("sh-await-verdict:h00", T0 + 2 * MINUTE)]), merged("b", 40)];

    expect(await value("quality.fix-rounds-p90", input({ runs }))).toEqual({ value: 2, n: 2 });
  });

  it("gives the red share of merged runs that read main CI", async () => {
    const runs = [merged("a", 40, [["sh-main-ci:0", T0 + 50 * MINUTE, { verdict: "red" }]]), merged("b", 40, [["sh-main-ci:0", T0 + 50 * MINUTE, { verdict: "green" }]])];

    expect(await value("quality.red-after-merge-rate", input({ runs }))).toEqual({ value: 0.5, n: 2 });
  });
});

describe("owner-load queries", () => {
  it("counts owner gates pending over 24 hours, leaving seat gates out", async () => {
    const gates = [gate("a/approve-merge:0", NOW - 30 * HOUR), gate("b/approve-merge:0", NOW - HOUR), gate("c/ci-failed:0", NOW - 40 * HOUR)];

    expect(await value("owner-load.overdue-owner-gates", input({ gates }))).toEqual({ value: 1, n: 2 });
  });

  it("averages owner touches over the days in range and gives the delegated share", async () => {
    const gates = [resolved("a/approve-merge:0", T0, T0 + HOUR, "owner-terminal"), resolved("b/approve-merge:0", T0, T0 + HOUR, "owner-remote"), resolved("c/approve-merge:0", T0, T0 + HOUR, "coordinator")];

    expect(await value("owner-load.touches-per-day", input({ gates }))).toEqual({ value: 1, n: 2 });
    expect(await value("owner-load.delegation-share", input({ gates }))).toEqual({ value: 0.333, n: 3 });
  });

  it("gives the cancelled share of gates opened in range", async () => {
    const gates = [gate("a/approve-merge:0", T0, { status: "cancelled", reason: "head moved" }), gate("b/approve-merge:0", T0)];

    expect(await value("owner-load.cancelled-gate-share", input({ gates }))).toEqual({ value: 0.5, n: 2 });
  });
});

describe("cost and business queries", () => {
  it("averages reviewer dollars and tokens over PRs whose every round was read", async () => {
    const pr = (usd: number, unreadable: number) => ({ repo: REPO, pr: 1, week: "2026-W41", rounds: 1, sessions: 1, usd, tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10 }, unreadable: Array.from({ length: unreadable }, () => ({ session: "s", reason: "gone" })) });
    const cost = async () => ({ ...EMPTY_COST, prs: [pr(1, 0), pr(2, 0), pr(9, 1)] });

    expect(await value("cost.reviewer-usd-per-merge", input({ cost }))).toEqual({ value: 1.5, n: 2 });
    expect(await value("cost.reviewer-tokens-per-merge", input({ cost }))).toEqual({ value: 20, n: 2 });
  });

  it("gives merges per day over the range and the share merged with no owner touch", async () => {
    const gates = [resolved("a/approve-merge:0", T0, T0 + HOUR, "owner-terminal")];
    const runs = [merged("a", 40), merged("b", 40), merged("c", 40)];

    expect(await value("business.merges-per-day", input({ runs }))).toEqual({ value: 1.5, n: 2 });
    expect(await value("business.unattended-share", input({ runs, gates }))).toEqual({ value: 0.667, n: 3 });
    expect(await value("cost.reviews-per-merge", input({ runs }))).toEqual({ value: 1, n: 3 });
  });
});
