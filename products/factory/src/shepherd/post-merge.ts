import { GITHUB_ACTIONS_APP_ID, headCheckFindings, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { deadline } from "../workflows/deadline.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps } from "./phases.js";

export const SH_MAIN_CI_TIMEOUT_MS = 60 * 60_000;
export const SH_MAIN_CI_POLL_MS = 30_000;

/** Stages a merge may be followed by. This slice runs none of them; a non-empty list goes to the owner. */
export const AFTER_STAGES = ["deploy", "release", "activation"] as const;

export type AfterStage = (typeof AFTER_STAGES)[number];

export const POST_MERGE_STEPS: readonly StepDeclaration[] = [
  { id: "sh-main-ci", kind: "dispatch" },
  { id: "main-red", kind: "assisted" },
  { id: "after-stages", kind: "assisted" },
];

const AfterStagesSchema = z.array(z.enum(AFTER_STAGES));

/** The stage list is an untrusted param: anything unreadable is refused, so it can only make the run stricter. */
export function afterStages(ctx: WorkflowContext): AfterStage[] {
  const raw = ctx.param("after");
  return raw === undefined ? [] : AfterStagesSchema.parse(JSON.parse(raw));
}

export const MainCiResult = z.looseObject({
  verdict: z.enum(["green", "red", "none"]),
  mergeSha: z.string(),
  after: AfterStagesSchema,
  detail: z.string(),
});

export type MainCi = z.infer<typeof MainCiResult>;

export interface MergedTarget {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
}

const OwnerAck = z.object({ decision: z.literal("acknowledged"), mergeSha: z.string() });

/** Reads main CI on the merge commit once, records it, and gives a red or unread main to the owner. Runs nothing after it. */
export async function shepherdMainCi(ctx: WorkflowContext, target: MergedTarget, after: readonly AfterStage[]): Promise<MainCi> {
  const result = await step(ctx, "sh-main-ci", { repo: target.repo, mergeSha: target.mergeSha, after }, MainCiResult);
  if (result.verdict !== "green") await askOwner(ctx, "main-red", `Main CI on ${target.repo} at merge ${target.mergeSha} (PR #${target.pr}) is ${result.verdict}: ${result.detail}. Acknowledge.`, target.mergeSha);
  if (result.after.length > 0) await askOwner(ctx, "after-stages", `PR #${target.pr} in ${target.repo} merged as ${target.mergeSha} with after stages [${result.after.join(", ")}]. Shepherd runs none of them; do them by hand, then acknowledge.`, target.mergeSha);
  return result;
}

async function askOwner(ctx: WorkflowContext, stepId: string, prompt: string, mergeSha: string): Promise<void> {
  const answer = await ctx.assisted(stepId, prompt, { schema: OwnerAck });
  if (OwnerAck.parse(answer.data).mergeSha !== mergeSha) throw new Error(`${stepId} answer names a different merge sha than ${mergeSha}`);
}

export interface MainCiInput {
  repo: RepoSlug;
  mergeSha: string;
  after: AfterStage[];
}

export function postMergeRoutes(deps: ShepherdDeps): StepRoute[] {
  const timing = { now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs ?? SH_MAIN_CI_POLL_MS, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
  return [codeRoute("sh-main-ci", deps.now, (input: MainCiInput, signal) => readMainCi(deps.port, input, timing, signal))];
}

export interface Timing {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
}

type Read = { verdict: "green" | "red"; detail: string } | { verdict: "pending"; detail: string };

/** Polls until every run at the merge sha has finished. A read error or the deadline is `none`, never green. */
export async function readMainCi(port: GitHubPort, input: MainCiInput, timing: Timing, signal: AbortSignal): Promise<MainCi> {
  const base = { mergeSha: input.mergeSha, after: input.after };
  if (input.mergeSha === "") return { ...base, verdict: "none", detail: "land returned no merge sha" };
  const clock = deadline(timing);
  let last = "no read yet";
  for (;;) {
    try {
      const read = evaluate(input.mergeSha, await port.checkRuns(input.repo, input.mergeSha));
      if (read.verdict !== "pending") return { ...base, ...read };
      last = read.detail;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (clock.expired()) return { ...base, verdict: "none", detail: `no verdict after ${timing.timeoutMs} ms: ${last}` };
    await clock.sleep(timing.pollMs, signal);
  }
}

/** Only allowed-app runs at the merge sha count, and each counts, so an older red survives a newer green of its name. */
function evaluate(mergeSha: string, runs: readonly CheckRun[]): Read {
  const counted = runs.filter((run) => run.headSha === mergeSha && run.appId === GITHUB_ACTIONS_APP_ID);
  if (counted.length === 0) return { verdict: "pending", detail: `no run from app ${GITHUB_ACTIONS_APP_ID} at ${mergeSha} yet` };
  const findings = headCheckFindings({ headSha: mergeSha, contexts: [], runs: counted, requiredApps: [GITHUB_ACTIONS_APP_ID] });
  const failed = findings.flatMap((finding) => (finding.kind === "failed" ? [finding.run.name] : []));
  if (failed.length > 0) return { verdict: "red", detail: `failed: ${failed.join(", ")}` };
  if (findings.length > 0) return { verdict: "pending", detail: `still running: ${findings.map((finding) => (finding.kind === "missing" ? finding.name : finding.run.name)).join(", ")}` };
  return { verdict: "green", detail: `${counted.length} runs passed` };
}
