import { describe, expect, it } from "vitest";
import { SHEPHERD_COMMAND_MAP } from "./commands.js";
import { formatShepherd } from "./format.js";
import type { WatchRow } from "./view.js";

const HEAD = "a".repeat(40);

const row = (held: WatchRow["held"]): WatchRow => ({
  repo: "acme/widgets",
  pr: 1,
  branch: "feat/x",
  runId: "run-1",
  task: "demo/T-1",
  phase: "merging",
  headSha: HEAD,
  phaseSince: "2026-01-01T00:00:00.000Z",
  nextAction: "merging",
  pendingGate: null,
  held,
  stalled: null,
  outcome: null,
});

describe("the shepherd text view of a hold", () => {
  it("names the head and the reviewer session that satisfied the hold, in status and timeline", () => {
    const satisfied = row({ reason: "awaiting a named review", satisfiedAt: HEAD, satisfiedBy: "rv-sec (agent-rv/session-rv)" });
    const expected = `held: awaiting a named review, satisfied at ${HEAD} by rv-sec (agent-rv/session-rv)`;

    const status = formatShepherd("shepherd.status", [satisfied]);
    const timeline = formatShepherd("shepherd.timeline", { row: satisfied, entries: [] });

    expect(status).toContain(expected);
    expect(timeline).toContain(expected);
  });

  it("shows the live stage with its age and the minutes since registration", () => {
    const live = { ...row(null), stage: { name: "review" as const, minutes: 12 }, totalMinutes: 45 };

    expect(formatShepherd("shepherd.status", [live])).toBe(`acme/widgets#1 merging ${HEAD.slice(0, 7)} merging (review 12m, 45m total)\n`);
  });

  it("shows an unsatisfied hold by its reason alone", () => {
    expect(formatShepherd("shepherd.status", [row({ reason: "owner review" })])).toBe(`acme/widgets#1 merging ${HEAD.slice(0, 7)} merging [held: owner review]\n`);
  });
});

describe("the shepherd text view of each verb", () => {
  const registered = (extra: object) => ({
    runId: "run-1",
    created: true,
    registration: { repo: "acme/widgets", pr: 1, branch: "feat/x", policy: { merge: "owner" } },
    ...extra,
  });

  it.each([
    ["a new run", registered({}), "run run-1 shepherd-pr acme/widgets#1 (feat/x): started; policy owner\n"],
    ["a repeat registration", registered({ created: false }), "run run-1 shepherd-pr acme/widgets#1 (feat/x): already registered, metadata updated; policy owner\n"],
    ["a restart after a failed run", registered({ previousRunId: "run-0" }), "run run-1 shepherd-pr acme/widgets#1 (feat/x): restarted after failed run run-0; policy owner\n"],
    ["a restart after a stopped run", registered({ previousRunId: "run-0", previousStop: "not-mergeable" }), "run run-1 shepherd-pr acme/widgets#1 (feat/x): restarted after run run-0 stopped not-mergeable; policy owner\n"],
    [
      "a branch with no PR yet",
      registered({ registration: { repo: "acme/widgets", pr: null, branch: "feat/x", policy: { merge: "auto" } } }),
      "run run-1 shepherd-pr acme/widgets (feat/x): started; policy auto\n",
    ],
  ])("prints register for %s", (_name, data, expected) => {
    expect(formatShepherd("shepherd.register", data)).toBe(expected);
  });

  it("prints an empty list and a row per run for list", () => {
    expect(formatShepherd("shepherd.list", [])).toBe("no shepherded PRs\n");
    expect(formatShepherd("shepherd.list", [row(null), { ...row(null), pr: null }])).toBe(`acme/widgets#1 merging aaaaaaa merging\nacme/widgets feat/x merging aaaaaaa merging\n`);
  });

  it("prints each timeline entry kind under the row", () => {
    const entries = [
      { kind: "step", stepId: "ci", status: "completed", completedAt: "2026-01-01T00:00:00.000Z" },
      { kind: "ci", stepId: "ci", headSha: HEAD, conclusion: "success" },
      { kind: "gate", gateId: "run-1/merge", status: "resolved", resolvedBy: "owner" },
      { kind: "signal", stepId: "wake" },
    ];
    expect(formatShepherd("shepherd.timeline", { row: { ...row(null), headSha: null }, entries })).toBe(
      "acme/widgets#1 merging - merging\n  step ci completed 2026-01-01T00:00:00.000Z\n  ci ci aaaaaaa success\n  gate run-1/merge resolved by owner\n  signal wake\n",
    );
  });

  it("prints a hold, release, freeze and thaw event with its reason and actor", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const entries = [
      { kind: "event", event: "hold", reason: "g10-review", actor: "coord", at, headSha: null },
      { kind: "event", event: "release", reason: null, actor: null, at, headSha: null },
    ];
    expect(formatShepherd("shepherd.timeline", { row: { ...row(null), headSha: null }, entries })).toBe(`acme/widgets#1 merging - merging\n  hold ${at}: g10-review (by coord)\n  release ${at}\n`);
  });

  it("prints hold and release by the run's hold state", () => {
    expect(formatShepherd("shepherd.hold", { runId: "run-1", held: { reason: "owner review" } })).toBe("run run-1: held (owner review)\n");
    expect(formatShepherd("shepherd.release", { runId: "run-1", held: null })).toBe("run run-1: released\n");
  });

  it("prints merge with and without a hold", () => {
    const evaluation = { runId: "run-1", phase: "merging", decision: { outcome: "gate", reason: "owner merges" }, held: null, waiting: "waiting on the owner" };
    expect(formatShepherd("shepherd.merge", evaluation)).toBe("run run-1 merging: policy says gate (owner merges); waiting on the owner\n");
    expect(formatShepherd("shepherd.merge", { ...evaluation, held: { reason: "freeze" } })).toBe("run run-1 merging: policy says gate (owner merges); held: freeze; waiting on the owner\n");
  });

  it.each([
    [true, "run 12345678 would end: merged outside Shepherd\nwould cancel 1 orphaned gate(s); would supersede 0 stale gate(s)\n"],
    [false, "run 12345678 ended: merged outside Shepherd\ncancelled 1 orphaned gate(s); superseded 0 stale gate(s)\n"],
  ])("prints resync with dryRun %s", (dryRun, expected) => {
    const report = { dryRun, ended: [{ runId: "1234567890", reason: "merged outside Shepherd" }], orphanGates: ["run-0/merge"], superseded: [] };
    expect(formatShepherd("shepherd.resync", report)).toBe(expected);
  });

  it("prints one resync line per superseded gate naming the run, both heads and the condition", () => {
    const superseded = [{ runId: "abcdef0123", gateId: "abcdef0123/approve-merge", from: "aaa1", to: "bbb2", condition: "head-moved" }];
    const report = { dryRun: false, ended: [], orphanGates: [], superseded };
    expect(formatShepherd("shepherd.resync", report)).toBe("run abcdef01 superseded its gate (head-moved): head aaa1 -> bbb2\ncancelled 0 orphaned gate(s); superseded 1 stale gate(s)\n");
  });
});

it("keys every shepherd command by its own name, so each verb finds its formatter", () => {
  for (const [key, command] of Object.entries(SHEPHERD_COMMAND_MAP)) expect(command.name).toBe(key);
});
