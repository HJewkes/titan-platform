import type { FactoryHost } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";
import { openHead } from "./head-moved.js";
import { REVIEW_INTENT_STEP, REVIEW_STEP } from "./review.js";

export interface SupersededReview {
  runId: string;
  stepId: string;
  from: string;
  to: string;
}

/** The steps that start a reviewer; a wait for a verdict starts nobody and runs out on its own. */
const REVIEW_AT_HEAD = new RegExp(`^(?:${REVIEW_INTENT_STEP}|${REVIEW_STEP}):([0-9a-f]+)$`);

function activeReviews(host: FactoryHost): { runId: string; stepId: string; head: string }[] {
  return host.runtime.list().flatMap((run) => {
    if (run.workflowName !== SHEPHERD_WORKFLOW) return [];
    return Object.keys(run.activeSteps).flatMap((stepId) => {
      const head = REVIEW_AT_HEAD.exec(stepId)?.[1];
      return head ? [{ runId: run.id, stepId, head }] : [];
    });
  });
}

/** The answer the review step reads on replay: no reviewer, so the run reads the PR again and takes its new head. */
const supersededOutput = (from: string, to: string): string =>
  JSON.stringify({ result: { kind: "none", reason: `superseded: the pull request moved from head ${from} to ${to}` } });

/**
 * Answers each active review step of a run no runtime holds whose head is no longer its open PR's head, so a restarted run
 * never starts a reviewer for a head it already left. A PR that cannot be read supersedes nothing. `dryRun` writes nothing.
 */
export async function supersedeStaleReviews(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<SupersededReview[]> {
  const superseded: SupersededReview[] = [];
  for (const { runId, stepId, head } of activeReviews(host)) {
    const current = await openHead(services, runId);
    if (!current || current === head) continue;
    if (dryRun || host.runtime.completeStep(runId, stepId, supersededOutput(head, current))) superseded.push({ runId, stepId, from: head, to: current });
  }
  return superseded;
}
