/**
 * The #/log rows (TP-6775): every merged PR and every auto-by-rec decision, merged into one list, newest first, one row
 * per PR. Pure, so the merge and its dedupe are tested without Shepherd or the files.
 *
 * A by-rec gate row names its PR in `facts.repo` and `facts.pr`. When that PR merged, the gate row folds into the ship
 * row: a live `resolved` row makes the ship's approval auto-by-rec, a shadow row only tags the ship with what by-rec would
 * have done. A gate row whose PR has not merged is a decision row of its own.
 */
import type { ByRecRow } from "@titan-design/owner-queue";

export type Approval = "owner" | "reviewer" | "plan" | "auto-by-rec" | "unrecorded";

/** The slice that wires the overrule tap; until it lands a decision row names it instead of a control. */
export const OVERRULE_TASK = "TP-6778";

export interface ShipInput {
  repo: string;
  pr: number;
  task: string;
  url: string;
  mergedAt: number;
  approval: Approval;
  /** The authority rule a reviewer release recorded, such as MRG-AU-RV. */
  rule?: string;
}

type Reverse = { kind: "revert"; href: string } | { kind: "overrule"; task: string } | { kind: "none"; reason: string };

export interface LogRow {
  key: string;
  day: string;
  kind: "ship" | "decision";
  source: "ship" | ByRecRow["subject"]["source"];
  /** How it was approved; a decision row is auto-by-rec, or `shadow` when by-rec only logged what it would have done. */
  approval: Approval | "shadow";
  /** A shadow by-rec row exists for it: by-rec would have resolved it. */
  shadow: boolean;
  rule?: string;
  title: string;
  href: string;
  recommendation?: ByRecRow["recommendation"];
  openedAt?: string;
  resolvedAt: string;
  resolver: string;
  result?: ByRecRow["result"];
  reverse: Reverse;
  /** A tier-2 visual gate (D2); slice G (TP-6777) fills `frames` with its before/after pair. */
  visual: boolean;
  frames: null;
}

export interface LogInput {
  ships: readonly ShipInput[];
  /** Shepherd's by-rec rows, from `shepherd by-rec --json`. */
  gateRows: readonly ByRecRow[];
  /** The console's own by-rec rows: rounds and deposits. */
  consoleRows: readonly ByRecRow[];
  dayOf: (ms: number) => string;
}

const SHOWN_RESULTS = new Set<ByRecRow["result"]>(["resolved", "would-resolve", "failed"]);
const RESOLVERS: Record<Approval, string> = { owner: "owner", reviewer: "reviewer", plan: "plan approval", "auto-by-rec": "auto-by-rec", unrecorded: "not recorded" };

const prKeyOf = (repo: string, pr: number): string => `${repo.toLowerCase()}#${pr}`;
const prUrl = (repo: string, pr: number): string => `https://github.com/${repo}/pull/${pr}`;

function prOfRow(row: ByRecRow): { repo: string; pr: number } | undefined {
  const { repo, pr } = row.facts;
  return typeof repo === "string" && typeof pr === "number" ? { repo, pr } : undefined;
}

/** A subject logged in both modes shows once: the live row wins, since it is what happened. */
function newestPerSubject(rows: readonly ByRecRow[], keyOf: (row: ByRecRow) => string | undefined): Map<string, ByRecRow[]> {
  const grouped = new Map<string, ByRecRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined || !SHOWN_RESULTS.has(row.result)) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

const liveOf = (rows: readonly ByRecRow[]): ByRecRow | undefined => rows.find((row) => row.mode === "live");
const shadowOf = (rows: readonly ByRecRow[]): ByRecRow | undefined => rows.find((row) => row.mode === "shadow");
const isVisual = (row: ByRecRow | undefined): boolean => row?.facts.decisionClass === "D2";

function shipRow(ship: ShipInput, byRec: readonly ByRecRow[], dayOf: LogInput["dayOf"]): LogRow {
  const live = liveOf(byRec);
  const shown = live?.result === "resolved" ? live : shadowOf(byRec);
  const approval: Approval = live?.result === "resolved" ? "auto-by-rec" : ship.approval;
  return {
    key: prKeyOf(ship.repo, ship.pr),
    day: dayOf(ship.mergedAt),
    kind: "ship",
    source: "ship",
    approval,
    shadow: shadowOf(byRec) !== undefined,
    ...(approval === "reviewer" && ship.rule !== undefined && { rule: ship.rule }),
    ...(approval === "auto-by-rec" && { rule: "MRG-AU-RB" }),
    title: `${ship.repo}#${ship.pr} ${ship.task}`,
    href: ship.url,
    ...(shown && { recommendation: shown.recommendation, openedAt: shown.openedAt }),
    resolvedAt: new Date(ship.mergedAt).toISOString(),
    resolver: RESOLVERS[approval],
    reverse: { kind: "revert", href: ship.url },
    visual: isVisual(shown),
    frames: null,
  };
}

function decisionHref(row: ByRecRow): string {
  const pr = prOfRow(row);
  if (pr !== undefined) return prUrl(pr.repo, pr.pr);
  const roundId = row.facts.roundId;
  return row.subject.source === "round" && typeof roundId === "string" ? `#/rounds/${encodeURIComponent(roundId)}` : "#/inbox";
}

function decisionRow(key: string, rows: readonly ByRecRow[], dayOf: LogInput["dayOf"]): LogRow {
  const row = liveOf(rows) ?? rows[0]!;
  const live = row.mode === "live";
  return {
    key,
    day: dayOf(Date.parse(row.resolvedAt)),
    kind: "decision",
    source: row.subject.source,
    approval: live ? "auto-by-rec" : "shadow",
    shadow: shadowOf(rows) !== undefined,
    title: row.subject.summary ?? row.subject.id,
    href: decisionHref(row),
    recommendation: row.recommendation,
    openedAt: row.openedAt,
    resolvedAt: row.resolvedAt,
    resolver: `${row.resolver.class}:${row.resolver.id}`,
    result: row.result,
    reverse: live && row.result === "resolved" ? { kind: "overrule", task: OVERRULE_TASK } : { kind: "none", reason: live ? "nothing was applied" : "shadow: nothing was applied" },
    visual: isVisual(row),
    frames: null,
  };
}

const newestFirst = (a: LogRow, b: LogRow): number => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Every ship once, every by-rec subject once, a gate folded into the ship of its PR; newest first. */
export function mergeLog({ ships, gateRows, consoleRows, dayOf }: LogInput): LogRow[] {
  const gates = newestPerSubject(gateRows, (row) => {
    const pr = prOfRow(row);
    return pr === undefined ? `gate:${row.subject.id}` : prKeyOf(pr.repo, pr.pr);
  });
  const shipped = new Map(ships.map((ship) => [prKeyOf(ship.repo, ship.pr), ship]));
  const shipRows = [...shipped.values()].map((ship) => shipRow(ship, gates.get(prKeyOf(ship.repo, ship.pr)) ?? [], dayOf));
  const openGates = [...gates].filter(([key]) => !shipped.has(key)).map(([key, rows]) => decisionRow(key, rows, dayOf));
  const asked = newestPerSubject(consoleRows, (row) => `${row.subject.source}:${row.subject.id}`);
  const askRows = [...asked].map(([key, rows]) => decisionRow(key, rows, dayOf));
  return [...shipRows, ...openGates, ...askRows].sort(newestFirst);
}

export interface LogCounts {
  ships: number;
  byApproval: Record<Approval, number>;
  decisions: number;
  shadow: number;
}

export function logCounts(rows: readonly LogRow[]): LogCounts {
  const byApproval: Record<Approval, number> = { owner: 0, reviewer: 0, plan: 0, "auto-by-rec": 0, unrecorded: 0 };
  let decisions = 0;
  for (const row of rows) {
    if (row.kind === "ship" && row.approval !== "shadow") byApproval[row.approval] += 1;
    if (row.kind === "decision" && row.approval === "auto-by-rec") decisions += 1;
  }
  return { ships: rows.filter((row) => row.kind === "ship").length, byApproval, decisions, shadow: rows.filter((row) => row.shadow || row.approval === "shadow").length };
}

/** The digest line: one sentence of counts and the page link. */
export function digestLine(counts: LogCounts): string {
  const { owner, reviewer, plan, unrecorded } = counts.byApproval;
  const shipped = `${counts.ships} shipped (${owner} by you, ${reviewer} by reviewer, ${plan} by plan approval, ${counts.byApproval["auto-by-rec"]} by rec${unrecorded > 0 ? `, ${unrecorded} not recorded` : ""})`;
  return `Decisions and ships: ${shipped}, ${counts.decisions} decided by rec, ${counts.shadow} shadow would-have. See #/log.`;
}
