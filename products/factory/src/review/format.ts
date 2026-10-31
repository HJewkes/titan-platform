import { DEFAULT_REVIEW_STEP_IDS, type ParkedRun, type Resumed, type ReviewOutcome } from "@titan-design/review-workflow";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { EXIT } from "../exit-codes.js";

/** One member dispatch the run recorded, retries included. */
export interface ReviewMember {
  shape: string;
  name: string;
  profile: string;
  /** `started`, `never-started` or `refused`. */
  dispatch: string;
}

/** What one `titan-factory review` run ended with. */
export interface ReviewReport {
  runId: string;
  outcome: ReviewOutcome;
  members: readonly ReviewMember[];
}

/**
 * Only a MERGE, or a carry of a head the review already signed off, exits 0. Every other outcome needs someone to act,
 * `needs-update` included: the CLI never updates a branch, so a zero there would read as reviewed and ready.
 */
export function exitCodeOf(outcome: ReviewOutcome): number {
  return outcome.kind === "MERGE" || outcome.kind === "carried" ? EXIT.OK : EXIT.FAILURE;
}

/** `<dispatch id>:<head>[:<shape>][:r2]`; correctness is the one shape the id leaves out. */
function shapeOf(stepId: string, dispatchId: string): string {
  const [, shape] = stepId.slice(dispatchId.length + 1).split(":");
  return shape === undefined || shape === "r2" ? "correctness" : shape;
}

const DispatchStepSchema = z.object({ result: z.object({ kind: z.string(), name: z.string(), profile: z.string() }) });

/** The member dispatches a run recorded, in the order the run took them. */
export function membersOf(run: Pick<WorkflowRun, "stepResults">, dispatchId: string = DEFAULT_REVIEW_STEP_IDS.dispatch): ReviewMember[] {
  return Object.values(run.stepResults).flatMap((step) => {
    const read = step.stepId.startsWith(`${dispatchId}:`) ? DispatchStepSchema.safeParse(step.data) : undefined;
    if (!read?.success) return [];
    const { kind, name, profile } = read.data.result;
    return [{ shape: shapeOf(step.stepId, dispatchId), name, profile, dispatch: kind }];
  });
}

const fingerprintOf = (outcome: ReviewOutcome): string | null => (outcome.kind === "needs-fixer" ? outcome.fingerprint : null);

/** The `--json` object: one per review, so a caller reads the outcome, the members and any fingerprint from one line. */
export function reviewJson({ runId, outcome, members }: ReviewReport): object {
  return { runId, outcome: outcome.kind, head: outcome.head, fingerprint: fingerprintOf(outcome), members, detail: outcome };
}

/** The one line after the outcome that says what to do next; the CLI does none of it. */
function nextLine(outcome: ReviewOutcome): string | undefined {
  switch (outcome.kind) {
    case "needs-update":
      return "The branch is behind its base and merges clean; update it, then review again. This command does not update it.";
    case "conflict":
      return "The branch conflicts with its base; the author resolves it.";
    case "needs-fixer":
      return `Parked on ${outcome.fingerprint} (${outcome.failure}). Once the fix is in: titan-factory review resolve ${outcome.fingerprint}`;
    case "head-moved":
      return `The head moved to ${outcome.current}; review that head, or pass --wait-ci.`;
    case "ci-not-green":
      return `CI is ${outcome.ci} at this head.`;
    default:
      return undefined;
  }
}

function memberLines(members: readonly ReviewMember[]): string[] {
  return members.map((member) => `  ${member.shape}: ${member.name} (${member.profile}) ${member.dispatch}`);
}

export function formatReview(report: ReviewReport): string {
  const { outcome } = report;
  const next = nextLine(outcome);
  const members = report.members.length === 0 ? ["Members: none dispatched"] : ["Members:", ...memberLines(report.members)];
  return [`Outcome: ${outcome.kind}`, `Head: ${outcome.head}`, `Run: ${report.runId}`, ...members, ...(next === undefined ? [] : [next])].join("\n") + "\n";
}

const runLine = (run: ParkedRun): string => `${run.target.repo}#${run.target.pr} at ${run.target.head}`;

export function formatResolved(fingerprint: string, resumed: readonly Resumed[]): string {
  if (resumed.length === 0) return `No run is parked on ${fingerprint}.\n`;
  const lines = resumed.map((entry) => ("outcome" in entry ? `${runLine(entry.run)}: ${entry.outcome.kind}` : `${runLine(entry.run)}: error, parked again: ${entry.error}`));
  return [`Resolved ${fingerprint}:`, ...lines.map((line) => `  ${line}`)].join("\n") + "\n";
}

/** Every resumed run must reach an outcome that exits 0; one still blocked, or one that errored, fails the resolve. */
export function resolveExitCode(resumed: readonly Resumed[]): number {
  return resumed.every((entry) => "outcome" in entry && exitCodeOf(entry.outcome) === EXIT.OK) ? EXIT.OK : EXIT.FAILURE;
}
