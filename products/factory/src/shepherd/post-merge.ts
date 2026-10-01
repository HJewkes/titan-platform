import { GITHUB_ACTIONS_APP_ID, headCheckFindings, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { deadline } from "../workflows/deadline.js";
import { codeRoute, step } from "../workflows/land.js";
import { CleanupResult, runCleanup, type CleanupInput } from "./cleanup.js";
import { FixTaskResult, FixerResult, FreezeResult, UnfreezeResult, mainRedRoutes, type MainRedWiring, type RedInput, type ThawInput } from "./main-red.js";
import type { ShepherdDeps } from "./phases.js";

export const SH_MAIN_CI_TIMEOUT_MS = 60 * 60_000;
export const SH_MAIN_CI_POLL_MS = 30_000;

/** Stages a merge may be followed by. This slice runs none of them; a non-empty list goes to the owner. */
export const AFTER_STAGES = ["deploy", "release", "activation"] as const;

export type AfterStage = (typeof AFTER_STAGES)[number];

export const POST_MERGE_STEPS: readonly StepDeclaration[] = [
  { id: "sh-main-ci", kind: "dispatch" },
  { id: "sh-unfreeze", kind: "dispatch" },
  { id: "sh-freeze", kind: "dispatch" },
  { id: "sh-file-fix-task", kind: "dispatch" },
  { id: "sh-spawn-fixer", kind: "dispatch" },
  { id: "sh-thaw", kind: "dispatch" },
  { id: "main-red", kind: "assisted" },
  { id: "main-red-again", kind: "assisted" },
  { id: "main-frozen", kind: "assisted" },
  { id: "after-stages", kind: "assisted" },
  { id: "sh-cleanup", kind: "dispatch" },
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

/**
 * Reads main CI on the merge commit once and records it. Green may unfreeze the repo; red freezes it, files one fix task
 * and spawns one fixer per episode; an unread main goes to the owner. Then cleans up. Runs no after stage.
 */
export async function shepherdMainCi(ctx: WorkflowContext, target: MergedTarget, after: readonly AfterStage[], fixer = false): Promise<MainCi> {
  const result = await step(ctx, "sh-main-ci", { repo: target.repo, mergeSha: target.mergeSha, after }, MainCiResult);
  const red = { repo: target.repo, pr: target.pr, mergeSha: target.mergeSha, runId: ctx.runId };
  if (result.verdict === "green") await onMainGreen(ctx, red);
  else if (result.verdict === "red") await onMainRed(ctx, red, fixer, result.detail);
  else await askOwner(ctx, "main-red", `Main CI on ${target.repo} at merge ${target.mergeSha} (PR #${target.pr}) is ${result.verdict}: ${result.detail}. Acknowledge.`, target.mergeSha);
  if (result.after.length > 0) await askOwner(ctx, "after-stages", `PR #${target.pr} in ${target.repo} merged as ${target.mergeSha} with after stages [${result.after.join(", ")}]. Shepherd runs none of them; do them by hand, then acknowledge.`, target.mergeSha);
  await step(ctx, "sh-cleanup", { repo: target.repo, pr: target.pr, runId: ctx.runId }, CleanupResult);
  return result;
}

/** A fixer is spawned at most once per episode; a red while one exists, its own merge included, goes to the owner instead. */
async function onMainRed(ctx: WorkflowContext, red: RedInput, fixer: boolean, detail: string): Promise<void> {
  const where = `Main CI on ${red.repo} at merge ${red.mergeSha} (PR #${red.pr}) is red: ${detail}.`;
  const frozen = await step(ctx, "sh-freeze", red, FreezeResult);
  const episode = { ...red, episode: frozen.episode };
  if (frozen.state === "again") return askFrozen(ctx, "main-red-again", episode, `${where} The repo was already frozen with fixer ${frozen.fixer} on task ${frozen.fixTask}. Stay frozen, or unfreeze?`);
  if (frozen.state === "unwired") return askOwner(ctx, "main-red", `${where} No freeze store is wired. Acknowledge.`, red.mergeSha);
  const filed = await step(ctx, "sh-file-fix-task", red, FixTaskResult);
  if (filed.task === null) return askFrozen(ctx, "main-frozen", episode, `${where} The repo is frozen; no fix task was filed: ${filed.detail}. ${NO_FIXER_EXIT}`);
  const spawned = await step(ctx, "sh-spawn-fixer", { repo: red.repo, mergeSha: red.mergeSha, task: filed.task, fixer }, FixerResult);
  if (spawned.fixer === null) await askFrozen(ctx, "main-frozen", episode, `${where} The repo is frozen with fix task ${filed.task}; no fixer was spawned: ${spawned.detail}. ${NO_FIXER_EXIT}`);
}

const NO_FIXER_EXIT = "No PR is exempt from the freeze, so nothing Shepherd merges can clear it. Stay frozen until a green head on main thaws it, or unfreeze now?";

/** A green merge that leaves the repo frozen has no fixer left to clear it, so the owner decides. */
async function onMainGreen(ctx: WorkflowContext, red: RedInput): Promise<void> {
  const result = await step(ctx, "sh-unfreeze", red, UnfreezeResult);
  if (!result.frozen) return;
  const prompt = `Main CI on ${red.repo} at merge ${red.mergeSha} (PR #${red.pr}) is green, but the repo stays frozen: ${result.detail}. Only a later green head on main thaws it. Stay frozen, or unfreeze?`;
  await askFrozen(ctx, "main-frozen", { ...red, episode: result.episode }, prompt);
}

const FrozenAnswer = z.object({ decision: z.enum(["stay-frozen", "unfreeze"]), mergeSha: z.string() });

/** Every outcome that leaves the repo frozen with no live way out ends here, with the owner's release on offer. */
async function askFrozen(ctx: WorkflowContext, gate: "main-red-again" | "main-frozen", red: ThawInput, prompt: string): Promise<void> {
  const answer = FrozenAnswer.parse((await ctx.assisted(gate, prompt, { schema: FrozenAnswer })).data);
  if (answer.mergeSha !== red.mergeSha) throw new Error(`${gate} answer names a different merge sha than ${red.mergeSha}`);
  if (answer.decision === "unfreeze") await step(ctx, "sh-thaw", red, z.looseObject({ thawed: z.boolean() }));
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

/** Absent `mainRed` still routes every step: a red main then goes to the owner with nothing frozen. */
export function postMergeRoutes(deps: ShepherdDeps, mainRed?: MainRedWiring): StepRoute[] {
  const timing = { now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs ?? SH_MAIN_CI_POLL_MS, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
  return [
    codeRoute("sh-main-ci", deps.now, (input: MainCiInput, signal) => readMainCi(deps.port, input, timing, signal)),
    ...mainRedRoutes(deps, mainRed),
    codeRoute("sh-cleanup", deps.now, (input: CleanupInput, signal) => runCleanup(deps, input, signal)),
  ];
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
