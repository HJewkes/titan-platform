import type { FactoryHost } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";
import { SUPERSEDED, gateHead } from "./stale-gates.js";

const APPROVE_MERGE_GATE = /\/approve-merge(:\d+)?$/;

export interface SupersededGate {
  runId: string;
  gateId: string;
  from: string;
  to: string;
}

/** The open PR's head now; undefined while it cannot be read, and for a merged or closed PR, which the gone sweep ends. */
async function openHead(services: ShepherdServices, runId: string): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => undefined);
  return pr?.state === "open" ? pr.headSha : undefined;
}

/** Cancels each shepherd-pr approve-merge gate whose PR moved past the head it asks about; the run then reviews the new head. */
export async function supersedeMovedGates(host: FactoryHost, services: ShepherdServices): Promise<SupersededGate[]> {
  const superseded: SupersededGate[] = [];
  for (const { runId, gate } of host.pendingGates()) {
    const asked = APPROVE_MERGE_GATE.test(gate.id) ? gateHead(gate.prompt) : undefined;
    if (!asked || host.runtime.status(runId)?.workflowName !== SHEPHERD_WORKFLOW) continue;
    const head = await openHead(services, runId);
    if (!head || head === asked || host.gates.get(gate.id)?.status !== "pending") continue;
    host.gates.cancel(gate.id, `${SUPERSEDED}the pull request moved from head ${asked} to ${head}`);
    superseded.push({ runId, gateId: gate.id, from: asked, to: head });
  }
  return superseded;
}
