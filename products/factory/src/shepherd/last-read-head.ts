import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { readPath } from "../narrow.js";

function headIn(result: StepResult | undefined): string | undefined {
  try {
    const head = readPath(JSON.parse(result?.output ?? "{}"), "result", "headSha");
    return typeof head === "string" ? head : undefined;
  } catch {
    return undefined;
  }
}

/** The head of the run's latest `ci-wait` read; land merges, or asks stuck-behind about, the head it read just before. */
export function lastReadHead(run: WorkflowRun): string | undefined {
  const reads = Object.values(run.stepResults).filter((result) => stepIdMatches("ci-wait", result.stepId));
  return headIn(reads.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1));
}
