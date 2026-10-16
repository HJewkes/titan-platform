import type { GateRecord } from "@titan-design/hitl";
import { landGate, stepOf } from "../coordinator-evidence.js";
import { groupBy, median, round } from "./owner-friction.js";

const HOUR_MS = 3_600_000;

/** Table and row names never hold a colon or a space, and row names may hold `+`, as in `design-coord+voltras-coord`. */
const POLICY = /Policy ([\w-]+)\/([^:\s]+):/;

export interface GateStatsRow {
  /** `<table>/<row>` from the prompt's `Policy` line, else `step/<step id>` for a gate that names none. */
  policyRow: string;
  /** `owner-terminal`, `owner-remote`, `coordinator`, `delegate` (resolved under a grant) or `unanswered`; any other class reads as itself. */
  resolver: string;
  count: number;
  /** Resolved gates counted by the decision they carried, such as `merge`, `abandon`, `approve` or `other`. */
  decisions: Record<string, number>;
  /** Gates cancelled or expired before anyone answered. */
  cancelledUnanswered: number;
  pending: number;
  medianHours: number;
  maxHours: number;
}

export function policyRow(gate: GateRecord): string {
  const match = POLICY.exec(gate.prompt);
  return match ? `${match[1]}/${match[2]}` : `step/${stepOf(gate.id)}`;
}

function resolverBucket(gate: GateRecord): string {
  if (gate.status !== "resolved") return "unanswered";
  if (gate.resolvedEvidence?.kind === "delegate") return "delegate";
  return gate.resolvedBy?.class ?? "unrecorded";
}

function decisionOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "other";
  if ("decision" in payload && typeof payload.decision === "string") return payload.decision;
  if ("approve" in payload && typeof payload.approve === "boolean") return payload.approve ? "approve" : "decline";
  return "other";
}

/** A closed gate waited until it closed; a pending one is still waiting at `now`. */
function waitHours(gate: GateRecord, now: number): number {
  const closed = gate.status === "pending" || gate.resolvedAt === undefined ? now : Date.parse(gate.resolvedAt);
  return (closed - Date.parse(gate.createdAt)) / HOUR_MS;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Every gate in `gates` shares one policy row and resolver bucket, so the first names the row. */
function row(gates: readonly GateRecord[], now: number): GateStatsRow {
  const hours = gates.map((gate) => waitHours(gate, now)).sort((a, b) => a - b);
  return {
    policyRow: policyRow(gates[0]!),
    resolver: resolverBucket(gates[0]!),
    count: gates.length,
    decisions: countBy(gates.filter((gate) => gate.status === "resolved").map((gate) => decisionOf(gate.payload))),
    cancelledUnanswered: gates.filter((gate) => gate.status === "cancelled" || gate.status === "expired").length,
    pending: gates.filter((gate) => gate.status === "pending").length,
    medianHours: round(median(hours)),
    maxHours: round(hours.at(-1)!),
  };
}

/** Gates created in the `sinceMinutes` before `now`, one row per policy row and resolver bucket. */
export function gateStats(gates: readonly GateRecord[], now: number, sinceMinutes: number): GateStatsRow[] {
  const start = now - sinceMinutes * 60_000;
  const recent = gates.filter((gate) => Date.parse(gate.createdAt) >= start);
  return [...groupBy(recent, (gate) => `${policyRow(gate)}\n${resolverBucket(gate)}`)]
    .map(([, items]) => row(items, now))
    .sort((a, b) => a.policyRow.localeCompare(b.policyRow) || a.resolver.localeCompare(b.resolver));
}

const VISUAL_RULE = "shepherd-merge-guard/visual-path";

export interface VisualGateStats {
  /** Approve-merge gates the visual rule opened in the window. */
  count: number;
  /** Still pending; they have no latency yet, so they stay out of the median and p90. */
  open: number;
  resolved: number;
  /** Open-to-resolve hours over the resolved gates; null when none resolved. */
  medianHours: number | null;
  p90Hours: number | null;
  /** Visual gates opened per PR beyond its first. */
  reAsks: number;
  prsWithReAsk: number;
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

function visualGatesOf(gates: readonly GateRecord[], now: number, sinceMinutes: number): { key: string; gate: GateRecord }[] {
  const start = now - sinceMinutes * 60_000;
  return gates.flatMap((gate) => {
    const land = landGate(gate);
    return land?.rule === VISUAL_RULE && Date.parse(gate.createdAt) >= start ? [{ key: `${land.repo}#${land.pr}`, gate }] : [];
  });
}

/** Visual-rule approve-merge gates opened in the window: open-to-resolve latency and the asks beyond each PR's first. */
export function visualGateStats(gates: readonly GateRecord[], now: number, sinceMinutes: number): VisualGateStats {
  const visual = visualGatesOf(gates, now, sinceMinutes);
  const resolved = visual.filter(({ gate }) => gate.status === "resolved" && gate.resolvedAt !== undefined);
  const hours = resolved.map(({ gate }) => (Date.parse(gate.resolvedAt!) - Date.parse(gate.createdAt)) / HOUR_MS).sort((a, b) => a - b);
  const perPr = [...groupBy(visual, ({ key }) => key).values()].map((items) => items.length);
  return {
    count: visual.length,
    open: visual.filter(({ gate }) => gate.status === "pending").length,
    resolved: resolved.length,
    medianHours: hours.length === 0 ? null : round(median(hours)),
    p90Hours: hours.length === 0 ? null : round(percentile(hours, 0.9)),
    reAsks: perPr.reduce((sum, n) => sum + n - 1, 0),
    prsWithReAsk: perPr.filter((n) => n > 1).length,
  };
}
