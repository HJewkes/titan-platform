import type { GateRecord } from "@titan-design/hitl";
import { mainGreenAt, type MainGreenEvidence } from "../coordinator-evidence-read.js";
import { MAIN_CI_TIMEOUT, mainMergeOf, stepOf } from "../coordinator-evidence.js";
import type { FactoryHost } from "../host.js";
import { RESYNC_CONCURRENCY, RESYNC_READ_TIMEOUT_MS, mapBounded } from "./bounded.js";
import { MAIN_GREEN } from "./main-green-ack.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./services.js";
import { cancelUnlessSettled } from "./stale-gates.js";

export interface ClearedMainGate {
  runId: string;
  gateId: string;
  reason: string;
}

type ClearReads = Pick<ShepherdServices, "store" | "port" | "readTimer" | "now">;

/** The reason names every fact the clear rests on, so the run's record of the gate and its gate-cancel event both carry the evidence. */
function mainGreenReason(evidence: MainGreenEvidence): string {
  const runs = evidence.runs.map((run) => `${run.name} #${run.id} ${run.conclusion}`).join(", ");
  const where = `main commit ${evidence.greenSha} on ${evidence.base} of ${evidence.repo} contains merge ${evidence.mergeSha} of PR #${evidence.pr} (merge base ${evidence.mergeBaseSha})`;
  return `${MAIN_GREEN}${where} and is green on every required context: ${runs}; read ${evidence.readAt}`;
}

/** The evidence for a gate the run's own registration names, else undefined; a gate about some other PR is never cleared here. */
function evidenceFor(services: ClearReads, runId: string, gate: GateRecord): Promise<MainGreenEvidence | undefined> {
  const main = mainMergeOf(gate);
  const registration = services.store.get().byRun(runId);
  if (!main || registration?.pr !== main.pr || registration.repo.toLowerCase() !== main.repo.toLowerCase()) return Promise.resolve(undefined);
  return mainGreenAt({ port: services.port, now: services.now ?? Date.now }, gate.id, main, { required: true });
}

/**
 * Cancels each pending main-ci-timeout gate whose merge the base branch's tip now contains, green on every required
 * context, with a reason the run reads as the acknowledgement (owner round answer, TP-4319). A red, pending or unreadable
 * main, or a base with no required contexts, leaves the gate for the next sweep. `dryRun` cancels nothing.
 */
export async function clearGreenMainCiGates(host: FactoryHost, services: ClearReads, { dryRun = false } = {}): Promise<ClearedMainGate[]> {
  const gated = host.pendingGates().filter(({ runId, gate }) => stepOf(gate.id) === MAIN_CI_TIMEOUT && host.runtime.status(runId)?.workflowName === SHEPHERD_WORKFLOW);
  const reads = await mapBounded(gated, RESYNC_CONCURRENCY, ({ runId, gate }) => evidenceFor(services, runId, gate), { timeoutMs: RESYNC_READ_TIMEOUT_MS, timer: services.readTimer });
  const cleared: ClearedMainGate[] = [];
  for (const [index, { runId, gate }] of gated.entries()) {
    const read = reads[index]!;
    const evidence = read.status === "fulfilled" ? read.value : undefined;
    if (evidence === undefined) continue;
    const reason = mainGreenReason(evidence);
    if (!dryRun && !cancelUnlessSettled(host.gates, gate.id, reason)) continue;
    if (!dryRun) services.store.get().recordGateCancel(runId, reason, evidence.readAt);
    cleared.push({ runId, gateId: gate.id, reason });
  }
  return cleared;
}
