import { describe, expect, it } from "vitest";
import { gateStrip, gateStripReader, type StripInputs, type StripRead } from "./gate-strip.js";
import type { CheckRunsPage, ShepherdSource } from "./shepherd.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const OLD_HEAD = "fedcba0987654321fedcba0987654321fedcba09";
const RUN = "11111111-0000-4000-8000-000000000001";

type Row = Awaited<ReturnType<ShepherdSource["list"]>>[number] & { pr: number; headSha: string };
type Waiting = Awaited<ReturnType<ShepherdSource["waiting"]>>;

function row(overrides: Partial<Row> = {}): Row {
  return {
    repo: REPO,
    pr: 7,
    branch: "feat/x",
    runId: RUN,
    task: "example/EX-1",
    phase: "approve",
    headSha: HEAD,
    phaseSince: "2026-10-10T00:00:00.000Z",
    nextAction: "approve-merge",
    pendingGate: { gateId: `${RUN}/approve-merge`, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" },
    held: null,
    stalled: null,
    ...overrides,
  };
}

const ok = <T>(value: T): StripRead<T> => ({ ok: true, value });
const green = { kind: "ci", stepId: "sh-ci-wait", headSha: HEAD, conclusion: "green", runUrl: null };
const verdict = (reviewer: string, value: "MERGE" | "FIX_FIRST", headSha = HEAD, n = 1) => ({ kind: "verdict", stepId: `sh-await-verdict:${n}`, verdict: value, headSha, locator: null, reviewer });
const holdEvent = (reason: string, actor: string) => ({ kind: "event", event: "hold", reason, actor, at: "2026-10-10T01:00:00.000Z", headSha: HEAD });
const checks = (...runs: [string, string, string | null][]): CheckRunsPage => ({ total_count: runs.length, check_runs: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })) });
const NO_WAITING: Waiting = { owner: [], seat: [] };

function inputs(overrides: Partial<StripInputs> & { row?: Row } = {}): StripInputs & { row: Row } {
  return { row: row(), timeline: ok([green]), waiting: ok(NO_WAITING), checkRuns: ok(checks(["build", "completed", "success"])), ...overrides };
}

const unmetKeys = (input: StripInputs & { row: Row }): string[] => gateStrip(input).unmet.map((gate) => gate.key);

describe("gateStrip", () => {
  it("shows nothing unmet when CI is green at the head and nothing else waits", () => {
    expect(unmetKeys(inputs())).toEqual([]);
  });

  it("a MERGE at an older head is shown and not counted", () => {
    const strip = gateStrip(inputs({ row: row({ held: { reason: "g10-review: opus review at head" } }), timeline: ok([green, verdict("rev-a", "MERGE", OLD_HEAD)]) }));

    expect(strip.verdicts).toEqual([{ stepId: "sh-await-verdict:1", reviewer: "rev-a", verdict: "MERGE", headSha: OLD_HEAD, atHead: false }]);
    expect(strip.holds[0]?.merges).toEqual({ present: 0, needed: 1 });
    expect(strip.unmet).toContainEqual({ key: "hold:g10-review", label: "held: g10-review (0/1 MERGE) by an unrecorded actor" });
  });

  it("two MERGEs from one reviewer count once", () => {
    const strip = gateStrip(inputs({ row: row({ held: { reason: "g10-adversary: two reviewers" } }), timeline: ok([green, verdict("rev-a", "MERGE", HEAD, 1), verdict("rev-a", "MERGE", HEAD, 2)]) }));

    expect(strip.holds[0]?.merges).toEqual({ present: 1, needed: 2 });
  });

  it("a failed check-runs read is an unknown unmet row", () => {
    const strip = gateStrip(inputs({ checkRuns: { ok: false, gap: "factory shepherd.ghRead: GitHub answered 502" } }));

    expect(strip.ci.checks).toEqual([]);
    expect(strip.unmet).toEqual([{ key: "unknown:checkRuns", label: "unknown checkRuns: factory shepherd.ghRead: GitHub answered 502" }]);
  });

  it("a hold row names its actor from the timeline", () => {
    const reason = "g10-review: opus review at head";
    const strip = gateStrip(inputs({ row: row({ held: { reason } }), timeline: ok([holdEvent("seat: older", "someone-else"), holdEvent(reason, "shepherd"), green]) }));

    expect(strip.holds).toEqual([{ key: "hold:g10-review", holdClass: "g10-review", reason, actor: "shepherd", merges: { present: 0, needed: 1 } }]);
    expect(strip.unmet.find((gate) => gate.key === "hold:g10-review")?.label).toBe("held: g10-review (0/1 MERGE) by shepherd");
  });

  it("a pending ci-failed gate on the PR is an unmet other gate", () => {
    const gate = (stepId: string, pr: number) => ({ gateId: `${RUN}/${stepId}`, stepId, repo: REPO, pr, task: "example/EX-1", since: "2026-10-10T02:00:00.000Z", ageHours: 1 });
    const waiting = ok({ owner: [gate("approve-merge", 7), gate("ci-failed", 8)], seat: [gate("ci-failed", 7)] });

    const strip = gateStrip(inputs({ waiting }));

    expect(strip.otherGates).toEqual([{ key: "gate:ci-failed", stepId: "ci-failed", gateId: `${RUN}/ci-failed`, since: "2026-10-10T02:00:00.000Z" }]);
    expect(strip.unmet).toEqual([{ key: "gate:ci-failed", label: "pending gate ci-failed" }]);
  });

  it("names each failing or pending check when the factory's CI reading is not green at the head", () => {
    const red = { ...green, conclusion: "red" };
    const keys = unmetKeys(inputs({ timeline: ok([red]), checkRuns: ok(checks(["build", "completed", "failure"], ["lint", "in_progress", null], ["docs", "completed", "skipped"])) }));

    expect(keys).toEqual(["ci:build", "ci:lint"]);
  });

  it("reads a green CI at an older head as unmet", () => {
    expect(unmetKeys(inputs({ timeline: ok([{ ...green, headSha: OLD_HEAD }]) }))).toEqual(["ci:required"]);
  });

  it("shows a failing check the factory does not require without making it a gate", () => {
    const strip = gateStrip(inputs({ checkRuns: ok(checks(["build", "completed", "success"], ["optional", "completed", "failure"])) }));

    expect(strip.ci.checks).toContainEqual({ name: "optional", state: "fail" });
    expect(strip.unmet).toEqual([]);
  });

  it("makes a reviewer's FIX_FIRST at the head a gate until that reviewer MERGEs there", () => {
    expect(unmetKeys(inputs({ timeline: ok([green, verdict("rev-a", "FIX_FIRST")]) }))).toEqual(["verdict:rev-a"]);
    expect(unmetKeys(inputs({ timeline: ok([green, verdict("rev-a", "FIX_FIRST", HEAD, 1), verdict("rev-a", "MERGE", HEAD, 2)]) }))).toEqual([]);
  });

  it("names a repo freeze and who froze it", () => {
    const frozen = row({ repoFrozen: { repo: REPO, reason: "release week", actor: "coordinator", since: "2026-10-10T00:00:00.000Z" } });

    expect(gateStrip(inputs({ row: frozen })).unmet).toEqual([{ key: "hold:freeze", label: "held: freeze by coordinator" }]);
  });
});

function countingShepherd() {
  const calls: string[] = [];
  const shepherd: ShepherdSource = {
    list: async () => [row()],
    timeline: async (repo, pr) => {
      calls.push("timeline");
      return { row: row({ repo, pr }), entries: [green] };
    },
    waiting: async () => {
      calls.push("waiting");
      return NO_WAITING;
    },
    checkRuns: async () => {
      calls.push("checkRuns");
      return checks(["build", "completed", "success"]);
    },
    release: async () => {
      throw new Error("the strip never writes");
    },
  };
  return { shepherd, calls };
}

describe("gateStripReader", () => {
  it("reads one PR head at most once per window", async () => {
    let now = 0;
    const { shepherd, calls } = countingShepherd();
    const reader = gateStripReader(shepherd, () => now);

    await reader.readMany([row()]);
    now = 29_000;
    await reader.readMany([row()]);
    expect(calls).toEqual(["waiting", "timeline", "checkRuns"]);

    now = 31_000;
    await reader.readMany([row()]);
    expect(calls).toHaveLength(6);
  });

  it("re-reads a strip that had an unknown row", async () => {
    const { shepherd, calls } = countingShepherd();
    shepherd.checkRuns = async () => {
      calls.push("checkRuns");
      throw new Error("down");
    };
    const reader = gateStripReader(shepherd, () => 0);

    const first = await reader.readMany([row()]);
    await reader.readMany([row()]);

    expect(first.get(RUN)?.unmet.map((gate) => gate.key)).toEqual(["unknown:checkRuns"]);
    expect(calls.filter((call) => call === "checkRuns")).toHaveLength(2);
  });
});
