import { stepIdMatches } from "../definition.js";
import type { FactoryHost } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";
import { openHead } from "./head-moved.js";
import { AFTER_HOLD } from "./hold.js";
import { lastReadHead } from "./last-read-head.js";

export interface SupersededMerge {
  runId: string;
  stepId: string;
  from: string;
  to: string;
}

/** Each active merge step of a shepherd-pr run, with the head it merges. */
function activeMerges(host: FactoryHost): { runId: string; stepId: string; head: string }[] {
  return host.runtime.list().flatMap((run) => {
    const head = run.workflowName === SHEPHERD_WORKFLOW ? lastReadHead(run) : undefined;
    if (head === undefined) return [];
    return Object.keys(run.activeSteps).flatMap((stepId) => (stepIdMatches("merge", stepId) ? [{ runId: run.id, stepId, head }] : []));
  });
}

/**
 * Answers each active merge step of a run no runtime holds whose head is no longer its open PR's head with the answer a
 * hold wait ends on, no merge, so the run reads CI and reviews the new head, where any hold still applies. A merge at a
 * head GitHub has moved past can never go through. A live run's own hold wait sees the push. `dryRun` writes nothing.
 */
export async function supersedeStaleMerges(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<SupersededMerge[]> {
  const superseded: SupersededMerge[] = [];
  for (const { runId, stepId, head } of activeMerges(host)) {
    const current = await openHead(services, runId);
    if (!current || current === head) continue;
    if (dryRun || host.runtime.completeStep(runId, stepId, JSON.stringify({ result: AFTER_HOLD }))) superseded.push({ runId, stepId, from: head, to: current });
  }
  return superseded;
}
