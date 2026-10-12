import type { GateRecord } from "@titan-design/hitl";
import { cardFields, gateStepOf, proceedOf } from "../needs/gate-card.js";
import { gateStats } from "../shepherd/gate-stats.js";
import { groupBy, median, round } from "../shepherd/owner-friction.js";
import type { SeatBook } from "../shepherd/seats.js";
import { isOwnerResolved } from "./audit-sample.js";
import { grantOf, standingGrants, type StandingGrant } from "./grants.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NO_CLASS = "unclassed";

interface ClassRow {
  class: string;
  /** Owner resolves only: a resolve under a grant was not the owner's decision. */
  answered: number;
  /** Answered with the step's proceed option, such as `merge` for approve-merge. */
  approved: number;
  rate: number;
  cancelledUnanswered: number;
  medianWaitHours: number;
}

export interface FlaggedClass {
  class: string;
  answered: number;
  approved: number;
  rate: number;
  /** Why no demotion is proposed: the audit's bad outcomes in this class, or that it has no D-row; empty proposes one. */
  held: string[];
  /** Whether an audit result was consulted; without one, nothing says the class's approvals turned out well. */
  audited: boolean;
}

export interface OwnerGatesReport {
  from: string;
  to: string;
  /** The first resolve under a grant, when it falls after `from`: before it, a delegate's resolve reads as the owner's. */
  provenanceFrom: string | undefined;
  classes: ClassRow[];
  flagged: FlaggedClass[];
  grants: StandingGrant[];
}

interface ReportOptions {
  now: number;
  seats: SeatBook;
  windowDays?: number;
  minItems?: number;
  threshold?: number;
  /** Per class, the bad outcomes the same window's audit found (`badByClass`); a class listed here is held. Absent means no audit was consulted. */
  auditBad?: ReadonlyMap<string, readonly string[]>;
}

const classOf = (gate: GateRecord): string => cardFields(gate).class ?? NO_CLASS;

const waitHours = (gate: GateRecord): number => (Date.parse(gate.resolvedAt!) - Date.parse(gate.createdAt)) / HOUR_MS;
const closedUnanswered = (gate: GateRecord): boolean => gate.status === "cancelled" || gate.status === "expired";

/** The meter's rows for one step of one class, summed: its proceed option is what counts as approve. */
function stepCounts(gates: readonly GateRecord[], step: string, now: number, sinceMinutes: number) {
  const rows = gateStats(gates, now, sinceMinutes);
  const answered = rows.filter((row) => row.resolver !== "unanswered").flatMap((row) => Object.values(row.decisions));
  return {
    answered: answered.reduce((sum, n) => sum + n, 0),
    approved: rows.reduce((sum, row) => sum + (row.resolver === "unanswered" ? 0 : (row.decisions[proceedOf(step)] ?? 0)), 0),
    cancelledUnanswered: rows.reduce((sum, row) => sum + row.cancelledUnanswered, 0),
  };
}

function classRow(cls: string, gates: readonly GateRecord[], now: number, sinceMinutes: number): ClassRow {
  const steps = [...groupBy(gates, (gate) => gateStepOf(gate.id))].map(([step, items]) => stepCounts(items, step, now, sinceMinutes));
  const answered = steps.reduce((sum, step) => sum + step.answered, 0);
  const approved = steps.reduce((sum, step) => sum + step.approved, 0);
  const waits = gates.filter(isOwnerResolved).map(waitHours).sort((a, b) => a - b);
  return {
    class: cls,
    answered,
    approved,
    rate: answered === 0 ? 0 : round(approved / answered),
    cancelledUnanswered: steps.reduce((sum, step) => sum + step.cancelledUnanswered, 0),
    medianWaitHours: waits.length === 0 ? 0 : round(median(waits)),
  };
}

function flagOf(row: ClassRow, auditBad: ReadonlyMap<string, readonly string[]> | undefined): FlaggedClass {
  const bad = auditBad?.get(row.class) ?? [];
  const held = row.class === NO_CLASS ? ["no D-row to demote"] : bad.length > 0 ? [`audit found ${bad.join(", ")}`] : [];
  return { class: row.class, answered: row.answered, approved: row.approved, rate: row.rate, held, audited: auditBad !== undefined };
}

function provenanceFrom(gates: readonly GateRecord[], from: number): string | undefined {
  const first = gates.filter((gate) => grantOf(gate) !== undefined).map((gate) => gate.resolvedAt!).sort()[0];
  return first !== undefined && Date.parse(first) > from ? first : undefined;
}

/**
 * Per decision class over the trailing window: owner-answered count, approve rate, cancelled-unanswered and median wait.
 * A class at or above `threshold` over at least `minItems` answered is flagged for demotion unless the audit holds it.
 */
export function ownerGatesReport(gates: readonly GateRecord[], options: ReportOptions): OwnerGatesReport {
  const { now, seats, windowDays = 14, minItems = 20, threshold = 0.95, auditBad } = options;
  const from = now - windowDays * DAY_MS;
  const inWindow = gates.filter((gate) => Date.parse(gate.createdAt) >= from);
  const metered = inWindow.filter((gate) => isOwnerResolved(gate) || closedUnanswered(gate));
  const classes = [...groupBy(metered, classOf)].map(([cls, items]) => classRow(cls, items, now, windowDays * 1440)).sort((a, b) => a.class.localeCompare(b.class, undefined, { numeric: true }));
  const flagged = classes.filter((row) => row.answered >= minItems && row.approved >= threshold * row.answered).map((row) => flagOf(row, auditBad));
  return {
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    provenanceFrom: provenanceFrom(gates, from),
    classes,
    flagged,
    grants: standingGrants(seats, inWindow),
  };
}

const percent = (rate: number): string => `${Math.round(rate * 100)}%`;

function flagLine(flag: FlaggedClass): string {
  const head = `flag ${flag.class}  ${flag.approved}/${flag.answered} approved (${percent(flag.rate)})`;
  return flag.held.length > 0 ? `${head}  held: ${flag.held.join("; ")}` : `${head}  propose demotion to a (rule), b (reviewer) or c (decider)${flag.audited ? "" : "; no audit consulted"}`;
}

function grantLine(grant: StandingGrant): string {
  return `grant ${grant.grant}  ${grant.source}  resolved ${grant.resolved}${grant.gateIds.length > 0 ? `  ${grant.gateIds.join(", ")}` : ""}`;
}

export function formatOwnerGatesReport(report: OwnerGatesReport): string {
  const lines = [
    `owner gates ${report.from} to ${report.to}`,
    ...(report.provenanceFrom ? [`provenance reliable from ${report.provenanceFrom}; earlier delegate resolves read as owner`] : []),
    ...(report.classes.length === 0 ? ["no owner-answered gates in window"] : report.classes.map((row) => `${row.class}  answered ${row.answered}  approve ${percent(row.rate)}  cancelled-unanswered ${row.cancelledUnanswered}  median ${row.medianWaitHours}h`)),
    ...report.flagged.map(flagLine),
    ...report.grants.map(grantLine),
  ];
  return `${lines.join("\n")}\n`;
}
