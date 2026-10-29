import { prRef } from "@titan-design/session-read";
import type { Db } from "@titan-design/store-sqlite";
import { roleFromProfile } from "./roles.js";
import { DEFAULT_ACTIVE_CAP_MINUTES } from "./task-actuals.js";
import { readOriginsOf, readPrSessions, readSessionPrs, readSessionStats } from "./task-actuals-queries.js";
import type { ShepherdRunRecord } from "./task-actuals-shepherd.js";

export type EstimateBand = "0-1" | "2" | "3" | "4+" | "none";
/** Whether the profile that ran is the one the table wanted; `none` when the row records no pick. */
export type RouteAgreement = "agree" | "differ" | "none";

export interface RouteOutcomesOptions {
  /** Shepherd's per-run records, as `titan-factory shepherd stats --per-run --json` prints them. */
  shepherdRuns: readonly ShepherdRunRecord[];
  /** Only spawns at or after this ISO time count. */
  since?: string;
}

/**
 * One group of routed spawns. Lite gets the smaller slices, so groups split by prior and estimate band
 * and are never pooled: a comparison across priors would measure the slice sizes, not the tiers.
 */
export interface RouteOutcomeGroup {
  table: string | null;
  mode: string | null;
  prior: string | null;
  estimateBand: EstimateBand;
  profile: string | null;
  source: string | null;
  agreement: RouteAgreement;
  /** The profile that ran against the shadow candidate table's pick. */
  candidateAgreement: RouteAgreement;
  spawns: number;
  prs: number;
  mergedPrs: number;
  /** Merged PRs whose first review passed, over merged PRs with a known review count; null when there are none. */
  cleanFirstPassPct: number | null;
  reviewRoundsPerPr: number | null;
  /** Spawns beyond the first on each PR, per PR. */
  fixSpawnsPerPr: number | null;
  implementerUsdPerMergedPr: number | null;
  /** Implementer spend plus the reviewers linked to the group's PRs. */
  allInUsdPerMergedPr: number | null;
}

interface RoutedSpawn {
  sessionId: string;
  profile: string | null;
  taskIds: string[];
  key: GroupKey;
}

type GroupKey = Pick<RouteOutcomeGroup, "table" | "mode" | "prior" | "estimateBand" | "profile" | "source" | "agreement" | "candidateAgreement">;

interface PrOutcome {
  prRef: string;
  merged: boolean;
  reviewRounds: number | null;
  spawns: number;
}

type Row = Record<string, unknown>;

const SPAWN_SQL = `SELECT session_id AS sessionId, profile, COALESCE(task_ids, '[]') AS taskIds, route_mode AS mode,
    route_source AS source, route_prior AS prior, route_table AS "table", route_wanted AS wanted,
    route_facts AS facts, route_candidate_wanted AS candidateWanted
  FROM session_origin WHERE route_mode IS NOT NULL AND (@since IS NULL OR spawned_at >= @since)`;

export function routeOutcomes(db: Db, options: RouteOutcomesOptions): RouteOutcomeGroup[] {
  const spawns = readRoutedSpawns(db, options.since ?? null);
  const usd = sessionUsd(db, spawns.map((s) => s.sessionId));
  const prsBySession = new Map<string, { prRef: string; mergedAt: string | null }[]>();
  for (const link of readSessionPrs(db, spawns.map((s) => s.sessionId))) {
    prsBySession.set(link.sessionId, [...(prsBySession.get(link.sessionId) ?? []), link]);
  }
  const groups = new Map<string, RoutedSpawn[]>();
  for (const spawn of spawns) {
    const id = JSON.stringify(spawn.key);
    groups.set(id, [...(groups.get(id) ?? []), spawn]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, members]) => groupStats(db, members, prsBySession, usd, options.shepherdRuns));
}

function readRoutedSpawns(db: Db, since: string | null): RoutedSpawn[] {
  const rows = db.prepare(SPAWN_SQL).all({ since }).filter((r): r is Row => typeof r === "object" && r !== null);
  return rows.map((row) => {
    const profile = textOf(row, "profile");
    const parsed: unknown = JSON.parse(textOf(row, "taskIds") ?? "[]");
    return {
      sessionId: textOf(row, "sessionId") ?? "",
      profile,
      taskIds: Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
      key: {
        table: textOf(row, "table"),
        mode: textOf(row, "mode"),
        prior: textOf(row, "prior"),
        estimateBand: bandOf(textOf(row, "facts")),
        profile,
        source: textOf(row, "source"),
        agreement: agreementOf(profile, textOf(row, "wanted")),
        candidateAgreement: agreementOf(profile, textOf(row, "candidateWanted")),
      },
    };
  });
}

function textOf(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function agreementOf(profile: string | null, wanted: string | null): RouteAgreement {
  if (wanted === null) return "none";
  return profile === wanted ? "agree" : "differ";
}

/** `route_facts` is the launcher's compact JSON; an absent or unreadable estimate is its own band. */
function bandOf(facts: string | null): EstimateBand {
  const estimate = estimateOf(facts);
  if (typeof estimate !== "number" || !Number.isFinite(estimate)) return "none";
  if (estimate <= 1) return "0-1";
  if (estimate <= 2) return "2";
  return estimate <= 3 ? "3" : "4+";
}

function estimateOf(facts: string | null): unknown {
  if (facts === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(facts);
    return typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "estimate") : undefined;
  } catch {
    return undefined;
  }
}

function sessionUsd(db: Db, sessionIds: readonly string[]): Map<string, number> {
  return new Map(readSessionStats(db, sessionIds, [DEFAULT_ACTIVE_CAP_MINUTES]).map((s) => [s.sessionId, s.usd]));
}

type SessionPrs = ReadonlyMap<string, readonly { prRef: string; mergedAt: string | null }[]>;

function groupStats(db: Db, members: readonly RoutedSpawn[], prsBySession: SessionPrs, usd: ReadonlyMap<string, number>, runs: readonly ShepherdRunRecord[]): RouteOutcomeGroup {
  const outcomes = prOutcomes(members, prsBySession, runs);
  const all = [...outcomes.values()];
  const merged = all.filter((o) => o.merged);
  const known = merged.filter((o) => o.reviewRounds !== null);
  const rounds = all.flatMap((o) => (o.reviewRounds === null ? [] : [o.reviewRounds]));
  const implUsd = members.reduce((acc, s) => acc + (usd.get(s.sessionId) ?? 0), 0);
  const perMerged = (total: number) => (merged.length === 0 ? null : total / merged.length);
  return {
    ...members[0]!.key,
    spawns: members.length,
    prs: all.length,
    mergedPrs: merged.length,
    cleanFirstPassPct: known.length === 0 ? null : (100 * known.filter((o) => o.reviewRounds === 1).length) / known.length,
    reviewRoundsPerPr: mean(rounds),
    fixSpawnsPerPr: all.length === 0 ? null : all.reduce((acc, o) => acc + o.spawns - 1, 0) / all.length,
    implementerUsdPerMergedPr: perMerged(implUsd),
    allInUsdPerMergedPr: perMerged(implUsd + reviewerUsd(db, all.map((o) => o.prRef), members)),
  };
}

/** Each PR counts once per group, however many of its spawns link it. */
function prOutcomes(members: readonly RoutedSpawn[], prsBySession: SessionPrs, runs: readonly ShepherdRunRecord[]): Map<string, PrOutcome> {
  const outcomes = new Map<string, PrOutcome>();
  for (const spawn of members) {
    for (const pr of prsBySession.get(spawn.sessionId) ?? []) {
      const ref = pr.prRef.toLowerCase();
      const joined = runs.filter((run) => runJoins(run, ref, spawn.taskIds));
      const prior = outcomes.get(ref);
      outcomes.set(ref, {
        prRef: pr.prRef,
        merged: (prior?.merged ?? false) || pr.mergedAt !== null || joined.some((r) => r.mergedAt !== null),
        reviewRounds: prior?.reviewRounds ?? (joined.length === 0 ? null : joined.reduce((acc, r) => acc + r.reviewRounds, 0)),
        spawns: (prior?.spawns ?? 0) + 1,
      });
    }
  }
  return outcomes;
}

/**
 * A run joins on its PR, and on the spawn's task too when the run names one. A task alone is not
 * enough: two slices of one task each open a PR, and a task-only join hands both PRs to both spawns.
 */
function runJoins(run: ShepherdRunRecord, ref: string, taskIds: readonly string[]): boolean {
  if (run.pr === null || prRef(run.repo, run.pr).toLowerCase() !== ref) return false;
  const task = run.task;
  return task === null || taskIds.some((id) => task === id || task.endsWith(`/${id}`));
}

function reviewerUsd(db: Db, prRefs: readonly string[], members: readonly RoutedSpawn[]): number {
  const own = new Set(members.map((s) => s.sessionId));
  const linked = [...new Set(readPrSessions(db, prRefs).map((l) => l.sessionId))].filter((id) => !own.has(id));
  const reviewers = readOriginsOf(db, linked).filter((o) => roleFromProfile(o.profile) === "reviewer").map((o) => o.sessionId);
  return [...sessionUsd(db, reviewers).values()].reduce((acc, v) => acc + v, 0);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((acc, v) => acc + v, 0) / values.length;
}
