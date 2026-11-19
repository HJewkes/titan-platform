import type { Logger } from "@titan-design/daemon";
import { BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, byRecDecision, type ByRecPolicy, type ByRecRow } from "@titan-design/owner-queue";
import type { FactoryHost, PendingGate } from "../host.js";
import { startSweep, type Sweep } from "../sweep.js";
import { byRecPolicyOf, type AutoByRecConfig } from "./by-rec-config.js";
import { appendByRecRow, readByRecRows, rowKey } from "./by-rec-log.js";
import { BY_REC_RULE, readByRec, type ByRecRead, type ByRecReads } from "./by-rec-read.js";
import type { ShepherdServices } from "./services.js";
import { BY_REC_CANCEL, cancelUnlessSettled } from "./stale-gates.js";

const HOUR_MS = 3_600_000;
/** Ten minutes: the wait is a day, so a tick this coarse costs the owner nothing and GitHub few reads. */
const BY_REC_SWEEP_MS = 600_000;
const APPROVE_MERGE = "approve-merge";

export interface ByRecSweepDeps extends ByRecReads {
  host: Pick<FactoryHost, "runtime" | "pendingGates" | "gates">;
  /** `shepherd.autoByRec`, read at each tick so `off` or `live` applies without a restart. */
  config: () => AutoByRecConfig | undefined;
  logPath: string;
  now: () => number;
  warn?: (line: string) => void;
}

/** What one tick did with a gate past its wait: the row it wrote, or why it left the gate to the owner. */
export type ByRecOutcome = { gateId: string; row: ByRecRow } | { gateId: string; skip: string };

/**
 * One pass over the pending approve-merge gates (TP-6772). A gate past its wait whose facts, read afresh, satisfy the
 * by-rec policy and MRG-AU-RB is logged as would-resolve in shadow; in live it is cancelled with `auto-by-rec:`, which land
 * reads as a merge of that head, and logged as resolved. A gate logged once in a mode is never acted on again in it.
 */
export async function sweepByRec(deps: ByRecSweepDeps): Promise<ByRecOutcome[]> {
  const policy = byRecPolicyOf(deps.config());
  if (policy.mode === "off") return [];
  const now = deps.now();
  const logged = new Set(readByRecRows(deps.logPath).map(rowKey));
  const due = deps.host.pendingGates().filter((pending) => pending.stepId === APPROVE_MERGE && pastWait(pending, policy, now));
  const outcomes: ByRecOutcome[] = [];
  for (const pending of due) {
    if (logged.has(`${policy.mode}\n${pending.gate.id}`)) continue;
    const outcome = await judged(deps, pending, policy, now).catch((error: unknown) => ({ gateId: pending.gate.id, skip: `read-failed: ${String(error)}` }));
    if ("row" in outcome) appendByRecRow(deps.logPath, outcome.row);
    outcomes.push(outcome);
  }
  return outcomes;
}

/** No read is spent on a gate the clock alone keeps; the policy checks the clock again on the facts it reads. */
function pastWait({ gate }: PendingGate, policy: ByRecPolicy, now: number): boolean {
  return now - Date.parse(gate.createdAt) >= policy.afterHours * HOUR_MS;
}

async function judged(deps: ByRecSweepDeps, pending: PendingGate, policy: ByRecPolicy, now: number): Promise<ByRecOutcome> {
  const gateId = pending.gate.id;
  const read = await readByRec(deps, pending, now);
  if ("skip" in read) return { gateId, skip: read.skip };
  const decision = byRecDecision(read.subject, new Date(now), policy);
  if (!decision.eligible) return { gateId, skip: decision.reason };
  if (read.unmet.length > 0) return { gateId, skip: `${BY_REC_RULE} unmet: ${read.unmet.join(", ")}` };
  if (policy.mode === "shadow") return { gateId, row: rowOf(read, decision.rationale, now, "would-resolve") };
  const reason = `${BY_REC_CANCEL}${BY_REC_RULE} holds at ${read.land.head}; ${decision.rationale}`;
  if (!cancelUnlessSettled(deps.host.gates, gateId, reason, deps.warn)) return { gateId, skip: "settled-elsewhere" };
  return { gateId, row: rowOf(read, decision.rationale, now, "resolved") };
}

function rowOf(read: ByRecRead, rationale: string, now: number, result: "would-resolve" | "resolved"): ByRecRow {
  const { subject, merge, land } = read;
  return {
    schema: BY_REC_ROW_SCHEMA,
    subject: { source: "gate", id: subject.id, ...(subject.summary && { summary: subject.summary }) },
    recommendation: { answer: "merge", by: read.reviewer, rationale },
    openedAt: subject.openedAt,
    resolvedAt: new Date(now).toISOString(),
    facts: factsOf(read, land.rule, merge.headRef),
    mode: result === "resolved" ? "live" : "shadow",
    result,
    resolver: { ...BY_REC_RESOLVER },
  };
}

/** What the row keeps of the read, so an audit can re-check the merge without the run: the rule, the head and every fact MRG-AU-RB read. */
function factsOf({ land, merge, subject }: ByRecRead, rule: string, headRef: string | undefined) {
  return {
    authority: BY_REC_RULE, repo: land.repo, pr: land.pr, head: land.head, gateRule: rule, decisionClass: subject.decisionClass ?? null,
    headRef: headRef ?? null, holdClasses: merge.holdClasses ?? [], changedPaths: merge.changedPaths, requiredContexts: merge.requiredContexts,
    checkRuns: merge.checkRuns.map((run) => ({ name: run.name, appId: run.appId, conclusion: run.conclusion })),
    mergeTreeClean: merge.mergeTreeClean, repoFrozen: merge.repoFrozen,
  };
}

/** Starts the by-rec sweep under serve; it logs each row it writes, and each reason it leaves a gate to the owner once per process. */
export function startByRecSweep(host: FactoryHost, services: ShepherdServices, config: () => AutoByRecConfig | undefined, logPath: string, log: Logger): Sweep {
  const deps: ByRecSweepDeps = { host, services, config, logPath, now: services.now ?? Date.now, warn: (line) => log.warn({}, line) };
  const told = new Set<string>();
  const tick = async (): Promise<void> => {
    for (const outcome of await sweepByRec(deps)) {
      if ("row" in outcome) log.info({ gateId: outcome.gateId, result: outcome.row.result, mode: outcome.row.mode }, "auto-by-rec");
      else if (!told.has(`${outcome.gateId}\n${outcome.skip}`)) log.info({ gateId: outcome.gateId, skip: outcome.skip }, "auto-by-rec left the gate to the owner");
      if ("skip" in outcome) told.add(`${outcome.gateId}\n${outcome.skip}`);
    }
  };
  return startSweep(tick, BY_REC_SWEEP_MS, "auto-by-rec sweep", log);
}
