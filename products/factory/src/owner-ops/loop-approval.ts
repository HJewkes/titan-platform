import type { OwnerItemDeposit } from "@titan-design/owner-queue";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import { holdClassOf } from "../shepherd/g10-release.js";
import { LIVE } from "../shepherd/gone-elsewhere.js";
import { releaseAtHead } from "../shepherd/release-head.js";
import type { Registration } from "../shepherd/store.js";
import type { ShepherdServices } from "../shepherd/services.js";
import type { StandingAnswer } from "./standing-answers.js";

const G10_CLASSES: ReadonlySet<string> = new Set(["g10-review", "g10-adversary"]);
const SUMMARY_MAX = 200;

/** The g10 class the run is held under now, if any; the approval waits out only a g10 hold. */
export const g10HoldOf = (registration: Pick<Registration, "held" | "holdReason"> | undefined): string | undefined => {
  const holdClass = registration?.held ? holdClassOf(registration.holdReason) : undefined;
  return holdClass !== undefined && G10_CLASSES.has(holdClass) ? holdClass : undefined;
};

export type LoopState = { state: "merge" } | { state: "fix-first"; stepId: string } | { state: "open" };
/** Reads the loop's state on one run at one head; serve reads the run's own records through `loopAt`. */
export type LoopRead = (runId: string, head: string) => LoopState;

const StepData = z.looseObject({ result: z.looseObject({}) });
const at = (prefix: string, head: string) => new RegExp(`^${prefix}:${head}(:\\d+)?$`);

/**
 * What the adversary loop said at exactly `head`, from the Shepherd run's own records. A FIX_FIRST from the panel's aggregate
 * or the correctness reviewer closes it non-MERGE. Shepherd's g10 release step closes it MERGE once it judged the hold met
 * there: it released the hold itself, or, in shadow, would have. Anything else is still open.
 */
export function loopAt(run: Pick<WorkflowRun, "stepResults">, head: string): LoopState {
  const panel = at("sh-review-panel", head);
  const correctness = at("sh-await-verdict", head);
  const release = new RegExp(`^sh-g10-release:${head}:\\d+$`);
  let merged = false;
  for (const { stepId, data } of Object.values(run.stepResults)) {
    const parsed = StepData.safeParse(data);
    if (!parsed.success) continue;
    const { result } = parsed.data;
    if ((panel.test(stepId) && result.outcome === "FIX_FIRST") || (correctness.test(stepId) && result.verdict === "FIX_FIRST")) return { state: "fix-first", stepId };
    if (release.test(stepId) && (result.released === true || result.wouldRelease === true)) merged = true;
  }
  return merged ? { state: "merge" } : { state: "open" };
}

/** `closed`: the loop closed MERGE at the head and no g10 hold is left, so the run's approve-merge at that head may be answered. */
export type LoopResult =
  | { kind: "released"; actionId: string; runId: string; holdClass: string }
  | { kind: "closed"; actionId: string; runId: string }
  | { kind: "voided"; actionId: string; runId: string; reason: string }
  | { kind: "pending"; actionId: string; runId: string; reason: string };

export interface LoopDeps {
  host: FactoryHost;
  services: ShepherdServices;
  now: Date;
  loopRead?: LoopRead;
}

const runLoop = (host: FactoryHost): LoopRead => (runId, head) => {
  const run = host.runtime.status(runId);
  return run === undefined ? { state: "open" } : loopAt(run, head);
};

const short = (sha: string): string => sha.slice(0, 7);

/** The release event's actor, as `ownerRelease` writes it, so the record that lifted the hold can be read back. */
export const approvalActor = (confirmEvent: string): string => `owner-remote:titan-console proof ${confirmEvent}`;

/**
 * Why the owner's approval no longer stands, or the loop's state when it still does. The head is GitHub's, read now: a push
 * since the tap voids the approval even when the loop at the confirmed head later closes MERGE.
 */
async function standing(answer: StandingAnswer, { host, services, now, loopRead = runLoop(host) }: LoopDeps): Promise<{ void: string } | { loop: LoopState } | undefined> {
  if (Date.parse(answer.expiresAt) <= now.getTime()) return { void: `it expired at ${answer.expiresAt} before the adversary loop closed` };
  const pull = await services.port.getPr(answer.repo, answer.pr);
  if (pull.state !== "open") return undefined;
  if (pull.headSha !== answer.headSha) return { void: `the PR moved to a new head ${short(pull.headSha)} after you approved ${short(answer.headSha)}` };
  const loop = loopRead(answer.runId, answer.headSha);
  if (loop.state === "fix-first") return { void: `the adversary loop closed without a MERGE at ${short(answer.headSha)} (${loop.stepId} said FIX_FIRST)` };
  return { loop };
}

/**
 * One pass over an approval that waits out a g10 hold. It voids on a new head, a non-MERGE close or expiry. Once the loop closes
 * MERGE at the confirmed head it lifts the g10 hold as the owner, and Shepherd's run goes on to merge from there. A run that
 * has ended, or a PR no longer open, needs nothing.
 */
export async function sweepLoopApproval(answer: StandingAnswer, deps: LoopDeps): Promise<LoopResult | undefined> {
  const { actionId, runId } = answer;
  const registration = deps.services.store.get().byRun(runId);
  if (registration === undefined || !LIVE.has(deps.host.runtime.status(runId)?.status ?? "")) return undefined;
  const read = await standing(answer, deps).catch((error: unknown) => ({ unread: error instanceof Error ? error.message : String(error) }));
  if (read === undefined) return undefined;
  if ("unread" in read) return { kind: "pending", actionId, runId, reason: `${answer.repo}#${answer.pr} could not be read: ${read.unread}` };
  if ("void" in read) return { kind: "voided", actionId, runId, reason: read.void };
  if (read.loop.state === "open") return { kind: "pending", actionId, runId, reason: `the adversary loop has not closed at ${answer.headSha}` };
  const holdClass = g10HoldOf(registration);
  if (holdClass === undefined) return { kind: "closed", actionId, runId };
  return released(answer, holdClass, deps);
}

/** Shepherd re-reads the head and the hold inside the release; a refusal leaves the approval standing for the next pass. */
async function released(answer: StandingAnswer, holdClass: string, { services }: LoopDeps): Promise<LoopResult> {
  const { actionId, runId, repo, pr, headSha } = answer;
  try {
    await releaseAtHead(services.store.get(), services.port, { runId, repo, pr, head: headSha, actor: approvalActor(answer.confirmEvent), holdClass });
    return { kind: "released", actionId, runId, holdClass };
  } catch (error) {
    return { kind: "pending", actionId, runId, reason: `Shepherd refused the release: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The owner's inbox notice for a voided approval: one per tap, so a repeat files nothing new. */
export function voidNotice(answer: StandingAnswer, reason: string): OwnerItemDeposit {
  const ref = `${answer.repo}#${answer.pr}`;
  return {
    depositId: `merge-approval-void-${answer.actionId}`,
    asker: "titan-factory",
    kind: "do",
    door: "two-way",
    summary: `Merge approval voided: ${ref}`.slice(0, SUMMARY_MAX),
    context: `Your approval to merge ${ref} at ${short(answer.headSha)} once the adversary loop closed no longer stands: ${reason}. Nothing merged on it. Read the PR again and decide afresh.`,
    command: `titan-factory shepherd timeline ${ref}`,
  };
}
