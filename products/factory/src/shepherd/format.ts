import type { CommandMapOf } from "@titan-design/registry";
import type { ZodType } from "zod";
import { SHEPHERD_COMMAND_MAP, type MergeEvaluation, type Registered, type ShepherdCommandName } from "./commands.js";
import type { ResyncReport } from "./resync.js";
import { OVERDUE_HOURS, overdueOwnerGates, type Waiting, type WaitingGate } from "./waiting.js";
import type { PrTimeline, TimelineEntry, WatchRow } from "./view.js";

type ShepherdResults = { [Name in ShepherdCommandName]: CommandMapOf<typeof SHEPHERD_COMMAND_MAP>[Name]["result"] };
type Formatters = { [Name in ShepherdCommandName]: (data: ShepherdResults[Name]) => string };
type ResultSchemas = { [Name in ShepherdCommandName]: { result: ZodType<ShepherdResults[Name]> } };

/** A verb with no entry here fails to compile, so a new one cannot fall through to another verb's text. */
const FORMATTERS: Formatters = {
  "shepherd.register": formatRegistered,
  "shepherd.status": formatRows,
  "shepherd.list": formatRows,
  "shepherd.waiting": formatWaiting,
  "shepherd.timeline": formatTimeline,
  "shepherd.hold": formatHold,
  "shepherd.release": formatHold,
  "shepherd.merge": formatMerge,
  "shepherd.resync": formatResync,
};

const RESULT_SCHEMAS: ResultSchemas = SHEPHERD_COMMAND_MAP;

/** The human form of each `titan-factory shepherd` verb's result; `--json` prints the result itself instead. */
export function formatShepherd<Name extends ShepherdCommandName>(name: Name, data: unknown): string {
  return FORMATTERS[name](RESULT_SCHEMAS[name].result.parse(data));
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

function formatHold({ runId, held }: ShepherdResults["shepherd.hold"]): string {
  return `run ${runId}: ${held ? `held (${held.reason})` : "released"}\n`;
}

function formatRegistered(registered: Registered): string {
  const { runId, registration } = registered;
  const target = `${registration.repo}${registration.pr === null ? "" : `#${registration.pr}`}${registration.branch ? ` (${registration.branch})` : ""}`;
  return `run ${runId} shepherd-pr ${target}: ${registerOutcome(registered)}; policy ${registration.policy.merge}\n`;
}

function registerOutcome({ created, previousRunId, previousStop }: Registered): string {
  if (previousRunId) return previousStop ? `restarted after run ${previousRunId} stopped ${previousStop}` : `restarted after failed run ${previousRunId}`;
  return created ? "started" : "already registered, metadata updated";
}

function rowLine(row: WatchRow): string {
  const target = row.pr === null ? `${row.repo} ${row.branch}` : `${row.repo}#${row.pr}`;
  const head = row.headSha === null ? "-" : row.headSha.slice(0, 7);
  const blockers = [row.held && heldLine(row.held), row.stalled && `stalled: ${row.stalled.reason}`].filter(Boolean);
  return `${target} ${row.phase} ${head} ${row.nextAction}${blockers.length > 0 ? ` [${blockers.join("; ")}]` : ""}`;
}

/** A satisfied hold names the head and the reviewer session whose MERGE lets a merge there through. */
function heldLine(held: NonNullable<WatchRow["held"]>): string {
  if (held.satisfiedAt === undefined) return `held: ${held.reason}`;
  return `held: ${held.reason}, satisfied at ${held.satisfiedAt} by ${held.satisfiedBy ?? "unknown"}`;
}

function formatRows(rows: WatchRow[]): string {
  return rows.length === 0 ? "no shepherded PRs\n" : `${rows.map(rowLine).join("\n")}\n`;
}

function entryLine(entry: TimelineEntry): string {
  if (entry.kind === "step") return `  step ${entry.stepId} ${entry.status}${entry.completedAt ? ` ${entry.completedAt}` : ""}`;
  if (entry.kind === "ci") return `  ci ${entry.stepId} ${entry.headSha.slice(0, 7)} ${entry.conclusion}`;
  if (entry.kind === "gate") return `  gate ${entry.gateId} ${entry.status}${entry.resolvedBy ? ` by ${entry.resolvedBy}` : ""}`;
  return `  ${entry.kind} ${entry.stepId}`;
}

function formatTimeline({ row, entries }: PrTimeline): string {
  return `${[rowLine(row), ...entries.map(entryLine)].join("\n")}\n`;
}

function formatMerge({ runId, phase, decision, held, waiting }: MergeEvaluation): string {
  return `run ${runId} ${phase}: policy says ${decision.outcome} (${decision.reason}); ${held ? `held: ${held.reason}; ` : ""}${waiting}\n`;
}

function formatResync({ dryRun, ended, orphanGates, superseded, supersededReviews = [], supersededMerges = [] }: ResyncReport): string {
  const verb = dryRun ? "would end" : "ended";
  const runs = ended.map(({ runId, reason }) => `run ${runId.slice(0, 8)} ${verb}: ${reason}`);
  const gates = superseded.map(({ runId, from, to, condition }) => `run ${runId.slice(0, 8)} ${dryRun ? "would supersede" : "superseded"} its gate (${condition}): head ${from} -> ${to}`);
  const reviews = supersededReviews.map(({ runId, stepId, to }) => `run ${runId.slice(0, 8)} ${dryRun ? "would supersede" : "superseded"} its review step ${stepId}: head moved to ${to}`);
  const merges = supersededMerges.map(({ runId, stepId, to }) => `run ${runId.slice(0, 8)} ${dryRun ? "would answer" : "answered"} its merge step ${stepId} with no merge: head moved to ${to}`);
  const summary = `${dryRun ? "would cancel" : "cancelled"} ${orphanGates.length} orphaned gate(s); ${dryRun ? "would supersede" : "superseded"} ${superseded.length} stale gate(s)`;
  return `${[...runs, ...gates, ...reviews, ...merges, summary].join("\n")}\n`;
}
