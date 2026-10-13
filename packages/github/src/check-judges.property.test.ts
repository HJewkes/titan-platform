import { describe, expect, it } from "vitest";
import { latestPerName } from "./checks.js";
import { ciVerdict, type CiVerdict, type CiVerdictInput } from "./ci-verdict.js";
import type { CheckRun, CommitStatus, RequiredChecks } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, headCheckFindings, type CheckFinding, type HeadChecksInput } from "./readiness.js";

/*
 * Frozen copies of the three judges as origin/main 407a6d7e had them (TP-2465 slice a). Later slices
 * rebuild the live judges on one core; any divergence from these oracles must match a documented predicate.
 */
const ORACLE_ACTIONS = 15368;
const ORACLE_PASSING = new Set(["success", "neutral", "skipped"]);
const oracleIsPassing = (run: CheckRun) => run.status === "completed" && ORACLE_PASSING.has(run.conclusion ?? "");
const oracleIsSucceeded = (run: CheckRun) => run.status === "completed" && run.conclusion === "success";

function oracleLatestPerName(runs: readonly CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (!seen || oracleIsNewer(run, seen)) latest.set(run.name, run);
  }
  return [...latest.values()];
}

function oracleIsNewer(run: CheckRun, than: CheckRun): boolean {
  const a = run.startedAt ?? "";
  const b = than.startedAt ?? "";
  return a === b ? run.id > than.id : a > b;
}

type OracleFinding = { kind: "pending" | "bad"; text: string };

function oracleCiVerdict(input: CiVerdictInput): CiVerdict {
  const findings = input.rules.contexts.length > 0 ? oracleRequired(input) : oracleAll(input.runs, input.statuses);
  const pending = findings.filter((finding) => finding.kind === "pending").map((finding) => finding.text);
  if (pending.length > 0) return { verdict: "pending", reasons: pending };
  const bad = findings.map((finding) => finding.text);
  return bad.length > 0 ? { verdict: "red", reasons: bad } : { verdict: "green", reasons: [] };
}

function oracleRequired({ rules, runs, statuses }: CiVerdictInput): OracleFinding[] {
  const findings: (OracleFinding | null)[] = [];
  for (const context of rules.contexts) {
    const pins = rules.pins?.[context];
    if (pins) {
      findings.push(...pins.map((app) => oracleJudge(context, oracleNewest(runs, context, app), null)));
    } else {
      const state = statuses.find((status) => status.context === context)?.state ?? null;
      findings.push(oracleJudge(context, oracleNewest(runs, context, ORACLE_ACTIONS), state));
    }
  }
  return findings.filter((finding): finding is OracleFinding => finding !== null);
}

function oracleNewest(runs: readonly CheckRun[], name: string, app: number): CheckRun | null {
  let best: CheckRun | null = null;
  for (const run of runs) {
    if (run.name === name && run.appId === app && (!best || (run.startedAt ?? "") > (best.startedAt ?? ""))) best = run;
  }
  return best;
}

function oracleJudge(name: string, run: CheckRun | null, state: string | null): OracleFinding | null {
  if ((run?.status === "completed" && run.conclusion === "success") || state === "success") return null;
  if ((run && run.status !== "completed") || state === "pending" || (!run && state === null)) return { kind: "pending", text: name };
  return { kind: "bad", text: `${name}=${run ? run.conclusion : state}` };
}

function oracleAll(runs: readonly CheckRun[], statuses: readonly CommitStatus[]): OracleFinding[] {
  const findings: OracleFinding[] = [];
  for (const run of runs) {
    if (run.status !== "completed") findings.push({ kind: "pending", text: run.name });
    else if (!ORACLE_PASSING.has(run.conclusion ?? "")) findings.push({ kind: "bad", text: `${run.name}=${run.conclusion}` });
  }
  for (const status of statuses) {
    if (status.state === "pending") findings.push({ kind: "pending", text: status.context });
    else if (status.state !== "success") findings.push({ kind: "bad", text: `${status.context}=${status.state}` });
  }
  if (runs.length === 0 && !findings.some((finding) => finding.kind === "bad")) {
    findings.push({ kind: "pending", text: statuses.length > 0 ? "(no check-run yet)" : "(nothing reported yet)" });
  }
  return findings;
}

function oracleHeadCheckFindings({ headSha, contexts, runs, requiredApps }: HeadChecksInput): CheckFinding[] {
  const counted = runs.filter((run) => run.headSha === headSha && run.appId !== null && requiredApps.includes(run.appId));
  const nonGreen = counted.filter((run) => !oracleIsPassing(run)).map((run): CheckFinding => ({ kind: run.status === "completed" ? "failed" : "pending", run }));
  return [...contexts.flatMap((name) => oracleHeadRequired(name, counted)), ...nonGreen];
}

function oracleHeadRequired(name: string, counted: readonly CheckRun[]): CheckFinding[] {
  const named = counted.filter((run) => run.name === name);
  if (named.some(oracleIsSucceeded)) return [];
  if (named.length === 0) return [{ kind: "missing", name }];
  return named.every(oracleIsPassing) ? named.map((run): CheckFinding => ({ kind: "failed", run })) : [];
}

/* The universe the harness enumerates. */
const HEAD = "head-sha";
const OTHER_APP = 999;
const NAMES = ["validate", "lint"] as const;
const APPS = [GITHUB_ACTIONS_APP_ID, OTHER_APP] as const;
const SHAS = [HEAD, "old-sha"] as const;
const STATUSES = ["queued", "in_progress", "completed", "waiting", "bogus"] as const;
const CONCLUSIONS = ["success", "neutral", "skipped", "failure", "cancelled", "stale", "timed_out", "action_required", "startup_failure", null, "bogus"] as const;
const STARTS = [null, "2026-10-01T00:00:00Z", "2026-10-01T00:05:00Z"] as const;
const STATUS_STATES = ["success", "pending", "failure", "error", "bogus"] as const;

const RULES: readonly RequiredChecks[] = [
  { contexts: [], strict: false },
  { contexts: ["validate"], strict: false },
  { contexts: ["lint", "validate"], strict: false },
  { contexts: ["validate"], strict: false, pins: { validate: [GITHUB_ACTIONS_APP_ID] } },
  { contexts: ["validate"], strict: false, pins: { validate: [OTHER_APP] } },
  { contexts: ["lint", "validate"], strict: false, pins: { validate: [GITHUB_ACTIONS_APP_ID, OTHER_APP] } },
];
const STATUS_SETS: readonly CommitStatus[][] = [[], ...STATUS_STATES.map((state) => [{ context: "validate", state }])];
const REQUIRED_APPS: readonly number[][] = [[GITHUB_ACTIONS_APP_ID], [GITHUB_ACTIONS_APP_ID, OTHER_APP]];

type RunShape = Omit<CheckRun, "id" | "workflowRunId" | "pullRequests" | "url">;

function run(id: number, shape: RunShape): CheckRun {
  return { id, ...shape, workflowRunId: null, pullRequests: [], url: `https://example.test/runs/${id}` };
}

function* everyRunShape(): Generator<RunShape> {
  for (const name of NAMES)
    for (const appId of APPS)
      for (const headSha of SHAS)
        for (const status of STATUSES)
          for (const conclusion of CONCLUSIONS)
            for (const startedAt of STARTS) yield { name, appId, headSha, status, conclusion, startedAt };
}

/** mulberry32: a fixed seed keeps every failure reproducible from the case index alone. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, from: readonly T[]): T => from[Math.floor(random() * from.length)]!;

/** Ids are shuffled so a tie on `startedAt` meets the higher id both first and last in input order. */
function sampleRuns(random: () => number, count: number, shape: () => RunShape): CheckRun[] {
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids.map((id) => run(id, shape()));
}

function anyShape(random: () => number): RunShape {
  return {
    name: pick(random, NAMES),
    appId: pick(random, APPS),
    headSha: pick(random, SHAS),
    status: pick(random, STATUSES),
    conclusion: pick(random, CONCLUSIONS),
    startedAt: pick(random, STARTS),
  };
}

interface Snapshot {
  rules: RequiredChecks;
  runs: CheckRun[];
  statuses: CommitStatus[];
  requiredApps: readonly number[];
}

function* exhaustiveSnapshots(): Generator<Snapshot> {
  const runSets: CheckRun[][] = [[], ...Array.from(everyRunShape(), (shape) => [run(1, shape)])];
  for (const runs of runSets)
    for (const rules of RULES)
      for (const statuses of STATUS_SETS)
        for (const requiredApps of REQUIRED_APPS) yield { rules, runs, statuses, requiredApps };
}

function* sampledSnapshots(count: number, seed: number): Generator<Snapshot> {
  const random = seeded(seed);
  for (let i = 0; i < count; i++) {
    const runs = sampleRuns(random, 2 + Math.floor(random() * 2), () => anyShape(random));
    yield { rules: pick(random, RULES), runs, statuses: pick(random, STATUS_SETS), requiredApps: pick(random, REQUIRED_APPS) };
  }
}

const headInput = (snapshot: Snapshot): HeadChecksInput => ({ headSha: HEAD, contexts: snapshot.rules.contexts, runs: snapshot.runs, requiredApps: snapshot.requiredApps });

/**
 * The documented divergence: the oracle sorted a null start oldest and broke null ties by id; now a queued run with
 * no start is newest, even beside a completed one, and a completed one orders by id (TP-2465 b, TP-2714).
 */
function unstartedBesideStarted(runs: readonly CheckRun[]): boolean {
  return runs.some((unstarted) => unstarted.startedAt === null && runs.some((other) => other !== unstarted && other.name === unstarted.name && (other.startedAt !== null || other.status === "completed")));
}

/** Collects mismatches instead of asserting per case, so one failure reports its first few cases, not 50k. */
function mismatches(snapshots: Iterable<Snapshot>): { count: number; first: unknown[] } {
  const first: unknown[] = [];
  let count = 0;
  for (const snapshot of snapshots) {
    const checks = [
      ["ciVerdict", ciVerdict(snapshot), oracleCiVerdict(snapshot)],
      ["headCheckFindings", headCheckFindings(headInput(snapshot)), oracleHeadCheckFindings(headInput(snapshot))],
      ["latestPerName", latestPerName(snapshot.runs), oracleLatestPerName(snapshot.runs)],
    ] as const;
    for (const [judge, live, oracle] of checks) {
      if (JSON.stringify(live) === JSON.stringify(oracle)) continue;
      if (judge === "latestPerName" && unstartedBesideStarted(snapshot.runs)) continue;
      count++;
      if (first.length < 5) first.push({ judge, snapshot, live, oracle });
    }
  }
  return { count, first };
}

describe("check judges against their origin/main oracles", () => {
  it("agree on every snapshot of at most one run", () => {
    expect(mismatches(exhaustiveSnapshots())).toEqual({ count: 0, first: [] });
  });

  it("agree on 20k seeded snapshots of two or three runs", () => {
    expect(mismatches(sampledSnapshots(20_000, 2465))).toEqual({ count: 0, first: [] });
  });

  it("latestPerName diverges only on the documented null-start inputs, where a picked null start is incomplete or the highest id", () => {
    const diverged = Array.from(sampledSnapshots(20_000, 2465), (snapshot) => snapshot.runs).filter((runs) => JSON.stringify(latestPerName(runs)) !== JSON.stringify(oracleLatestPerName(runs)));

    expect(diverged.length).toBeGreaterThan(0);
    const highestId = (picked: CheckRun, runs: readonly CheckRun[]) => runs.every((other) => other.name !== picked.name || other.id <= picked.id);
    const pickJustified = (runs: readonly CheckRun[]) => latestPerName(runs).every((picked) => picked.startedAt !== null || picked.status !== "completed" || highestId(picked, runs));
    expect(diverged.every((runs) => unstartedBesideStarted(runs) && pickJustified(runs))).toBe(true);
  });
});

/*
 * Where both judges can be compared: required contexts with no pins, every run from Actions at the head,
 * no commit statuses. They still differ by design (TP-2465 plan risk 4); these are the only two classes.
 */
type Disagreement = "non-picked-run-not-passing" | "picked-run-not-success-but-another-succeeded";

function comparableSnapshot(random: () => number): Snapshot {
  const shape = (): RunShape => ({ ...anyShape(random), appId: GITHUB_ACTIONS_APP_ID, headSha: HEAD });
  const rules = pick(random, RULES.slice(1, 3));
  return { rules, runs: sampleRuns(random, 1 + Math.floor(random() * 3), shape), statuses: [], requiredApps: [GITHUB_ACTIONS_APP_ID] };
}

const ciGreen = (snapshot: Snapshot, judge: (input: CiVerdictInput) => CiVerdict) => judge(snapshot).verdict === "green";
const headGreen = (snapshot: Snapshot, judge: (input: HeadChecksInput) => CheckFinding[]) => judge(headInput(snapshot)).length === 0;

function classify({ rules, runs }: Snapshot): Disagreement | "unexplained" {
  const picks = rules.contexts.map((name) => oracleNewest(runs, name, ORACLE_ACTIONS));
  if (runs.some((candidate) => !picks.includes(candidate) && !oracleIsPassing(candidate))) return "non-picked-run-not-passing";
  const supersededSuccess = picks.some((picked) => picked && !oracleIsSucceeded(picked) && runs.some((other) => other.name === picked.name && oracleIsSucceeded(other)));
  return supersededSuccess ? "picked-run-not-success-but-another-succeeded" : "unexplained";
}

describe("old ciVerdict and old headCheckFindings on the comparable domain", () => {
  const random = seeded(2466);
  const snapshots = Array.from({ length: 20_000 }, () => comparableSnapshot(random));

  it("disagree only in the two documented classes, and both classes occur", () => {
    const seen = new Map<string, number>();
    for (const snapshot of snapshots) {
      if (ciGreen(snapshot, oracleCiVerdict) === headGreen(snapshot, oracleHeadCheckFindings)) continue;
      const kind = classify(snapshot);
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual(["non-picked-run-not-passing", "picked-run-not-success-but-another-succeeded"]);
  });

  it("give the same answer live wherever the old pair agreed", () => {
    const broken = snapshots.filter((snapshot) => {
      const old = ciGreen(snapshot, oracleCiVerdict);
      if (old !== headGreen(snapshot, oracleHeadCheckFindings)) return false;
      return ciGreen(snapshot, ciVerdict) !== old || headGreen(snapshot, headCheckFindings) !== old;
    });
    expect(broken.slice(0, 3)).toEqual([]);
  });
});
