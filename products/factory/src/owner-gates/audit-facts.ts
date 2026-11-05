import type { GateRecord } from "@titan-design/hitl";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { REVERTED_STEP } from "../shepherd/reverts.js";
import { payloadOf, stepName } from "../shepherd/stats.js";

/** How long after the owner's resolve a revert, a red main or an incident still counts against that decision. */
export const OUTCOME_WINDOW_MS = 72 * 3_600_000;

/** A deploy incident as the audit reads it: `target` is the sha the failed deploy tried to serve, `from` the build it replaced. */
export interface AuditIncident {
  at: string;
  target: string;
  from: string;
}

/** Per merge sha, the incidents of the rollouts that first brought it in, or `unknown` when ancestry could not tell for one. */
export type IncidentLinks = ReadonlyMap<string, AuditIncident[] | "unknown">;

export interface OutcomeFacts {
  /** The answer the owner gave, from the gate's `decision` payload. */
  decision: string | undefined;
  merged: boolean;
  mergeSha?: string;
  reverted: boolean;
  mainRed: boolean;
  /** `unknown` when no incident log was read or ancestry could not link one to the merge: unread is never zero. */
  incidents: AuditIncident[] | "unknown";
  /** False while the 72 h window is still open at `now`: its facts are partial, never a clean bill. */
  windowClosed: boolean;
}

/** Gate ids are `<runId>/<stepId>` or `<runId>/<stepId>:<n>`. */
export const runIdOf = (gateId: string): string => gateId.slice(0, gateId.indexOf("/"));

function decisionOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("decision" in payload)) return undefined;
  return typeof payload.decision === "string" ? payload.decision : undefined;
}

function resultsOf(run: WorkflowRun | undefined, name: string): StepResult[] {
  return Object.entries(run?.stepResults ?? {})
    .filter(([key]) => stepName(key) === name)
    .map(([, result]) => result)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
}

function mergeShaOf(run: WorkflowRun | undefined): string | undefined {
  const landed = Object.values(run?.stepResults ?? {}).find((result) => result.stepId === "sh-landed");
  const sha = landed && payloadOf(landed).mergeSha;
  return typeof sha === "string" && sha !== "" ? sha : undefined;
}

/** The sha `gate`'s run merged, read from its `sh-landed` step. */
export const gateMergeSha = (gate: GateRecord, runs: readonly WorkflowRun[]): string | undefined => mergeShaOf(runs.find((run) => run.id === runIdOf(gate.id)));

/** A merge the links never asked about has no answer, so it reads unknown rather than zero. */
function linkedIncidents(links: IncidentLinks | undefined, mergeSha: string | undefined, within: (at: string) => boolean): OutcomeFacts["incidents"] {
  if (links === undefined) return "unknown";
  if (mergeSha === undefined) return [];
  const linked = links.get(mergeSha);
  return linked === undefined || linked === "unknown" ? "unknown" : linked.filter((incident) => within(incident.at));
}

/** What followed the owner's resolve of `gate` within 72 h, read from its run's ledger and the incidents linked to its merge. */
export function outcomeFacts(gate: GateRecord, runs: readonly WorkflowRun[], links: IncidentLinks | undefined, now: number): OutcomeFacts {
  const resolvedAt = Date.parse(gate.resolvedAt ?? gate.createdAt);
  const within = (at: string): boolean => Date.parse(at) >= resolvedAt && Date.parse(at) <= resolvedAt + OUTCOME_WINDOW_MS;
  const run = runs.find((candidate) => candidate.id === runIdOf(gate.id));
  const mergeSha = gateMergeSha(gate, runs);
  const mainCi = resultsOf(run, "sh-main-ci").filter((result) => within(result.completedAt)).at(-1);
  return {
    decision: decisionOf(gate.payload),
    merged: mergeSha !== undefined,
    ...(mergeSha && { mergeSha }),
    reverted: resultsOf(run, REVERTED_STEP).some((result) => within(result.completedAt)),
    mainRed: mainCi !== undefined && payloadOf(mainCi).verdict === "red",
    incidents: linkedIncidents(links, mergeSha, within),
    windowClosed: now >= resolvedAt + OUTCOME_WINDOW_MS,
  };
}

/** The bad outcomes the facts show, in the words the report and the weekly card use. */
export function badOutcomes(facts: OutcomeFacts): string[] {
  return [
    ...(facts.reverted ? ["revert"] : []),
    ...(facts.mainRed ? ["red main"] : []),
    ...(Array.isArray(facts.incidents) && facts.incidents.length > 0 ? ["incident"] : []),
  ];
}
