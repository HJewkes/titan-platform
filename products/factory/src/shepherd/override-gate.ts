import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { landGateHead } from "./approval-carry.js";
import type { OwnerOverride } from "./override-stats.js";

const Declined = z.looseObject({ decision: z.literal("abandon"), headSha: z.string() });

/**
 * Wraps `assisted` so an owner answer to land's approve-merge gate that is anything but merge, at a head the run's reviewer
 * said MERGE at, is recorded as an override. The record is a measurement: a failure to write it is logged and never changes the answer.
 */
export function recordingOverrides(assisted: WorkflowContext["assisted"], reviewedMerge: (headSha: string) => boolean, record: (override: Omit<OwnerOverride, "at">) => Promise<void>, warn: (line: string) => void = console.warn): WorkflowContext["assisted"] {
  return async (stepId, prompt, options) => {
    const answer = await assisted(stepId, prompt, options);
    const asked = landGateHead(stepId, prompt);
    const declined = Declined.safeParse(answer.data);
    if (asked === undefined || !declined.success || declined.data.headSha !== asked || !reviewedMerge(asked)) return answer;
    await record({ trigger: "owner-answer", head: asked, shepherd: "MERGE", other: declined.data.decision }).catch((error: unknown) => warn(`shepherd: could not record the override at ${asked}: ${error instanceof Error ? error.message : String(error)}`));
    return answer;
  };
}
