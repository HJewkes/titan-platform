import type { CommandMapOf } from "@titan-design/registry";
import type { ZodType } from "zod";
import { SHEPHERD_COMMAND_MAP, type MergeEvaluation, type Registered, type ShepherdCommandName, type StatusRow } from "./commands.js";
import type { PrRow } from "./prs.js";
import type { OrderResult, OrderRow } from "./merge-order-command.js";
import type { RepairStopResult } from "./repair-stop-command.js";
import type { RepoFreezeResult } from "./repo-freeze-command.js";
import type { ReviewAsk } from "./review-request.js";
import type { ResyncReport } from "./resync.js";
import type { ThawResult } from "./thaw-command.js";
import type { WatchResult } from "./watch-command.js";
import type { FixPrResult } from "./fix-pr-command.js";
import type { MergeBaseResult } from "./merge-base-command.js";
import type { Freeze } from "./freeze.js";
import { lastAwaitClause } from "./none-reason.js";
import { OVERDUE_HOURS, overdueOwnerGates, type Waiting, type WaitingGate } from "./waiting.js";
import type { PrTimeline, TimelineEntry, WatchRow } from "./view.js";

/** `timeline --last N` keeps the last N entries; `--width W` cuts every line to W characters, the `| tail | cut -c` seats used to type. */
export interface TimelineView {
  last?: number;
  width?: number;
}

type ShepherdResults = { [Name in ShepherdCommandName]: CommandMapOf<typeof SHEPHERD_COMMAND_MAP>[Name]["result"] };
type Formatters = { [Name in ShepherdCommandName]: (data: ShepherdResults[Name], view: TimelineView) => string };
type ResultSchemas = { [Name in ShepherdCommandName]: { result: ZodType<ShepherdResults[Name]> } };

/** A verb with no entry here fails to compile, so a new one cannot fall through to another verb's text. */
const FORMATTERS: Formatters = {
  "shepherd.register": formatRegistered,
  "shepherd.status": formatStatus,
  "shepherd.list": formatRows,
  "shepherd.waiting": formatWaiting,
  "shepherd.timeline": formatTimeline,
  "shepherd.hold": formatHold,
  "shepherd.release": formatHold,
  "shepherd.repair-stop": formatRepairStops,
  "shepherd.freeze": formatRepoFreezes,
  "shepherd.thaw": formatThaw,
  "shepherd.order": formatOrder,
  "shepherd.fix-pr": formatFixPr,
  "shepherd.merge-base": formatMergeBase,
  "shepherd.merge": formatMerge,
  "shepherd.review": formatReviewAsk,
  "shepherd.resync": formatResync,
  "shepherd.prs": formatPrs,
  "shepherd.watch": formatWatches,
  // A calibration read feeds a threshold recommendation, so it prints JSON with or without --json.
  "shepherd.visual-delta": (report) => `${JSON.stringify(report, null, 2)}\n`,
  "shepherd.brief": (output) => (output.format === "md" ? output.markdown : `${JSON.stringify({ section: output.section, question: output.question }, null, 2)}\n`),
};

const RESULT_SCHEMAS: ResultSchemas = SHEPHERD_COMMAND_MAP;

/** The human form of each `titan-factory shepherd` verb's result; `--json` prints the result itself instead. */
export function formatShepherd<Name extends ShepherdCommandName>(name: Name, data: unknown, view: TimelineView = {}): string {
  return FORMATTERS[name](RESULT_SCHEMAS[name].result.parse(data), view);
}

function waitingLine(gate: WaitingGate): string {
  const target = gate.pr === null ? gate.repo : `${gate.repo}#${gate.pr}`;
  const head = gate.head === null ? "-" : gate.head.slice(0, 7);
  return `  ${gate.ageHours}h  ${gate.gateId}  ${target} ${head}  ${gate.task}${gate.headIsCurrent === false ? "  [head moved]" : ""}${gate.held === null ? "" : `  [held: ${gate.held}]`}`;
}

function formatWaiting(waiting: Waiting): string {
  const { owner, seat } = waiting;
  const overdue = overdueOwnerGates(waiting).length;
  const section = (title: string, gates: readonly WaitingGate[]): string[] => [`${title} (${gates.length}), oldest first:`, ...(gates.length === 0 ? ["  none"] : gates.map(waitingLine))];
  return `${[...section("waiting on the owner", owner), ...section("seat work", seat), ...(overdue > 0 ? [`${overdue} owner gate(s) over ${OVERDUE_HOURS} h`] : [])].join("\n")}\n`;
}

function prLine(row: PrRow): string {
  const head = row.state === "merged" ? `merged ${row.mergeSha?.slice(0, 7) ?? "-"}` : (row.headSha?.slice(0, 7) ?? "-");
  const run = row.runId === undefined ? "unregistered" : `${row.runId} ${row.phase}`;
  return `${row.repo}#${row.number}  ${head}  ${row.branch ?? "-"}  ${run}  ci ${row.ci?.state ?? "-"}${row.draft ? "  [draft]" : ""}`;
}

function formatPrs(rows: PrRow[]): string {
  return rows.length === 0 ? "no PRs\n" : `${rows.map(prLine).join("\n")}\n`;
}

function formatHold({ runId, held }: ShepherdResults["shepherd.hold"]): string {
  return `run ${runId}: ${held ? `held (${held.reason})` : "released"}\n`;
}

function formatRepairStops({ changed, stops }: RepairStopResult): string {
  const lines = stops.map((stop) => `${stop.repo}${stop.scope.startsWith("#") ? "" : ":"}${stop.scope}  ${stop.reason} (by ${stop.actor}, ${stop.at})`);
  return `${changed ? "changed; " : ""}${stops.length === 0 ? "no repair stops" : `repair stops:\n${lines.join("\n")}`}\n`;
}

function formatWatches({ changed, watches }: WatchResult): string {
  const lines = watches.map((watch) => `${watch.repo}#${watch.pr}  on ${watch.on.join(",")}  ${watch.seat === null ? "to its digest seat" : `copy to ${watch.seat}`} (by ${watch.actor}, ${watch.at})`);
  return `${changed ? "changed; " : ""}${watches.length === 0 ? "no watches" : `watches:\n${lines.join("\n")}`}\n`;
}

function formatMergeBase({ runId, changed, exception }: MergeBaseResult): string {
  if (exception) return `run ${runId}: fix rounds may merge the base (${exception.reason}; by ${exception.actor}, ${exception.at})\n`;
  return `run ${runId}: ${changed ? "exception revoked; " : ""}fix rounds do not merge the base\n`;
}

function formatRepoFreezes({ detail, freezes, mainRed = [] }: RepoFreezeResult): string {
  const lines = freezes.map((frozen) => `${frozen.repo}  ${frozen.reason} (by ${frozen.actor}, since ${frozen.since})`);
  const red = mainRed.length === 0 ? "" : `main-red freezes:\n${mainRed.map(mainRedLine).join("\n")}\n`;
  return `${detail ? `${detail}\n` : ""}${freezes.length === 0 ? "no repo freezes" : `repo freezes:\n${lines.join("\n")}`}\n${red}`;
}

function mainRedLine({ repo, episode, redSha, frozenAt, fixTask, fixer, fixPr, fixPrActor }: Freeze): string {
  const fix = fixPr === null ? "fix PR none" : `fix PR #${fixPr} (by ${fixPrActor ?? "unknown"})`;
  return `${repo}  episode ${episode} red at ${redSha.slice(0, 7)} since ${frozenAt}; fix task ${fixTask ?? "none"}, fixer ${fixer ?? "none"}, ${fix}`;
}

function formatFixPr({ repo, pr, episode, redSha, marked, actor, supersededGates }: FixPrResult): string {
  const head = marked ? `${repo}#${pr} marked by ${actor} as the fix PR of main-red episode ${episode}` : `${repo}#${pr} was already the fix PR of main-red episode ${episode}; nothing changed`;
  return `${[`${head} (red at ${redSha})`, ...supersededGates.map((gate) => `superseded ${gate}`)].join("\n")}\n`;
}

function formatThaw({ repo, episode, redSha, actor, fixTask, closedGates, alert }: ThawResult): string {
  const lines = [
    `${repo} thawed by hand: episode ${episode}, red at ${redSha}, by ${actor}`,
    `fix task ${fixTask ?? "none"} stays open`,
    ...closedGates.map((gate) => `cancelled ${gate.gateId}`),
    alert.sent ? `alerted ${alert.seat}` : `alert not sent: ${alert.detail}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatReviewAsk({ runId, head, requested }: ReviewAsk): string {
  return `run ${runId}: ${requested ? "asked for Shepherd's own review" : "Shepherd's own review was already asked"} at ${head}\n`;
}

function formatRegistered(registered: Registered): string {
  const { runId, registration } = registered;
  const target = `${registration.repo}${registration.pr === null ? "" : `#${registration.pr}`}${registration.branch ? ` (${registration.branch})` : ""}`;
  const held = registered.g10Hold === undefined ? "" : `; held ${registered.g10Hold}`;
  const notes = `${sizeWarning(registered)}${kindHintLine(registered)}`;
  return `run ${runId} shepherd-pr ${target}: ${registerOutcome(registered)}; policy ${registration.policy.merge}${held}\n${notes}`;
}

function kindHintLine({ kindHint }: Registered): string {
  return kindHint === undefined ? "" : `${kindHint}\n`;
}

function sizeWarning({ sizeFlag }: Registered): string {
  if (sizeFlag === undefined) return "";
  return `warning: security or guard-area PR is ${sizeFlag.lines} non-generated lines, over the ${sizeFlag.cap}-line slice cap; split the parser or list change from its wiring\n`;
}

function registerOutcome({ created, previousRunId, previousStop }: Registered): string {
  if (previousRunId) return previousStop ? `restarted after run ${previousRunId} stopped ${previousStop}` : `restarted after failed run ${previousRunId}`;
  return created ? "started" : "already registered, metadata updated";
}

function rowLine(row: WatchRow): string {
  const target = row.pr === null ? `${row.repo} ${row.branch}` : `${row.repo}#${row.pr}`;
  const head = row.headSha === null ? "-" : row.headSha.slice(0, 7);
  const frozen = row.repoFrozen && `repo frozen by ${row.repoFrozen.actor} since ${row.repoFrozen.since}: ${row.repoFrozen.reason}`;
  const blockers = [frozen, row.held && heldLine(row.held), row.stalled && `stalled: ${row.stalled.reason}`, lastAwaitClause(row)].filter(Boolean);
  return `${target} ${row.phase} ${head} ${row.nextAction}${timeSuffix(row)}${blockers.length > 0 ? ` [${blockers.join("; ")}]` : ""}`;
}

/** The live stage with its age, then the minutes since registration; nothing for a row that carries neither. */
function timeSuffix({ stage, totalMinutes }: WatchRow): string {
  const parts = [stage && `${stage.name} ${stage.minutes}m`, totalMinutes !== undefined && `${totalMinutes}m total`].filter(Boolean);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/** A satisfied hold names the head and the reviewer session whose MERGE lets a merge there through. */
function heldLine(held: NonNullable<WatchRow["held"]>): string {
  if (held.satisfiedAt === undefined) return `held: ${held.reason}`;
  return `held: ${held.reason}, satisfied at ${held.satisfiedAt} by ${held.satisfiedBy ?? "unknown"}`;
}

function formatRows(rows: WatchRow[]): string {
  return rows.length === 0 ? "no shepherded PRs\n" : `${rows.map(rowLine).join("\n")}\n`;
}

/** A row holding a merge-order reservation says so after its blockers. */
function formatStatus(rows: StatusRow[]): string {
  const reserved = ({ mergeOrder: held }: StatusRow): string =>
    held ? ` [merge order: reserved ${held.paths.length} path(s) since ${held.since}, ${held.state}${waitingText(held.waiting)}]` : "";
  return rows.length === 0 ? "no shepherded PRs\n" : `${rows.map((row) => `${rowLine(row)}${reserved(row)}`).join("\n")}\n`;
}

const waitingText = (waiting: readonly number[]): string => (waiting.length === 0 ? "" : `; ${waiting.map((pr) => `#${pr}`).join(", ")} waiting`);

function orderLine(row: OrderRow): string {
  const prs = (label: string, list: readonly number[]): string => (list.length === 0 ? "" : `; ${label} ${list.map((pr) => `#${pr}`).join(", ")}`);
  return `${row.repo}#${row.pr}  ${row.state}  ${row.ageMinutes}m  ${row.paths.length} path(s)${prs("ahead", row.ahead)}${prs("behind", row.behind)}${prs("waiting", row.waiting)}`;
}

function formatOrder({ cleared, reservations }: OrderResult): string {
  const head = cleared ? `cleared ${cleared.repo}#${cleared.pr}'s reservation\n` : "";
  return `${head}${reservations.length === 0 ? "no merge-order reservations" : `merge-order reservations:\n${reservations.map(orderLine).join("\n")}`}\n`;
}

function entryLine(entry: TimelineEntry): string {
  if (entry.kind === "step") return `  step ${entry.stepId} ${entry.status}${entry.completedAt ? ` ${entry.completedAt}` : ""}`;
  if (entry.kind === "ci") return `  ci ${entry.stepId} ${entry.headSha.slice(0, 7)} ${entry.conclusion}`;
  if (entry.kind === "gate") return `  gate ${entry.gateId} ${entry.status}${entry.resolvedBy ? ` by ${entry.resolvedBy}` : ""}`;
  if (entry.kind === "event") return `  ${entry.event} ${entry.at}${entry.reason ? `: ${entry.reason}` : ""}${entry.actor ? ` (by ${entry.actor})` : ""}`;
  return `  ${entry.kind} ${entry.stepId}`;
}

/** The timeline with only its last `last` entries, oldest first, and how many earlier ones it cut. */
export function lastEntries(timeline: PrTimeline, last: number | undefined): { timeline: PrTimeline; cut: number } {
  const cut = last === undefined ? 0 : Math.max(0, timeline.entries.length - last);
  return { timeline: { ...timeline, entries: timeline.entries.slice(cut) }, cut };
}

function formatTimeline(full: PrTimeline, { last, width }: TimelineView): string {
  const { timeline: { row, entries }, cut } = lastEntries(full, last);
  const header = `${rowLine(row)} task ${row.task}${row.slice ? ` slice ${row.slice}` : ""}`;
  const lines = [header, ...(cut > 0 ? [`  … ${cut} earlier entries`] : []), ...entries.map(entryLine)];
  return `${lines.map((line) => clip(line, width)).join("\n")}\n`;
}

function clip(line: string, width: number | undefined): string {
  return width === undefined || line.length <= width ? line : `${line.slice(0, width - 1)}…`;
}

function formatMerge({ runId, phase, decision, held, waiting }: MergeEvaluation): string {
  return `run ${runId} ${phase}: policy says ${decision.outcome} (${decision.reason}); ${held ? `held: ${held.reason}; ` : ""}${waiting}\n`;
}

function formatResync({ dryRun, ended, orphanGates, superseded, supersededReviews = [], supersededMerges = [], reverted = [] }: ResyncReport): string {
  const verb = dryRun ? "would end" : "ended";
  const runs = ended.map(({ runId, reason }) => `run ${runId.slice(0, 8)} ${verb}: ${reason}`);
  const gates = superseded.map(({ runId, from, to, condition }) => `run ${runId.slice(0, 8)} ${dryRun ? "would supersede" : "superseded"} its gate (${condition}): head ${from} -> ${to}`);
  const reviews = supersededReviews.map(({ runId, stepId, to }) => `run ${runId.slice(0, 8)} ${dryRun ? "would supersede" : "superseded"} its review step ${stepId}: head moved to ${to}`);
  const merges = supersededMerges.map(({ runId, stepId, to }) => `run ${runId.slice(0, 8)} ${dryRun ? "would answer" : "answered"} its merge step ${stepId} with no merge: head moved to ${to}`);
  const reverts = reverted.map(({ runId, mergeSha, revertSha }) => `run ${runId.slice(0, 8)} ${dryRun ? "would be marked" : "marked"} reverted: merge ${mergeSha} reverted by ${revertSha}`);
  const summary = `${dryRun ? "would cancel" : "cancelled"} ${orphanGates.length} orphaned gate(s); ${dryRun ? "would supersede" : "superseded"} ${superseded.length} stale gate(s)`;
  return `${[...runs, ...gates, ...reviews, ...merges, ...reverts, summary].join("\n")}\n`;
}
