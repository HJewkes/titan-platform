import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";

const VerdictRecord = z.looseObject({ kind: z.literal("verdict"), verdict: z.string(), head: z.string(), reviewer: z.looseObject({ agentId: z.string() }) });

const awaitResults = (run: WorkflowRun, step: string) => Object.values(run.stepResults).filter((result) => result.stepId === step || result.stepId.startsWith(`${step}:`));

/** The reviewer's verdict recorded at exactly this head; a correction or retry at the head must agree, or there is none. */
export function verdictAt(run: WorkflowRun, head: string): { step: string; verdict: string; head: string; reviewer: string } | undefined {
  const step = `sh-await-verdict:${head}`;
  const results = awaitResults(run, step);
  const records = results.map((result) => VerdictRecord.safeParse(result.data?.result));
  const base = records[results.findIndex((result) => result.stepId === step)];
  if (!base?.success || !records.every((record) => record.success && record.data.verdict === "MERGE" && record.data.head === head)) return undefined;
  return { step, verdict: base.data.verdict, head: base.data.head, reviewer: base.data.reviewer.agentId };
}

/** True when a reviewer's FIX_FIRST is recorded at exactly this head, by the first await or a correction of it. */
export function fixFirstAt(run: WorkflowRun, head: string): boolean {
  return awaitResults(run, `sh-await-verdict:${head}`).some((result) => {
    const record = VerdictRecord.safeParse(result.data?.result);
    return record.success && record.data.verdict === "FIX_FIRST" && record.data.head === head;
  });
}
