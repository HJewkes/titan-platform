import { GITHUB_ACTIONS_APP_ID, headCheckFindings, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { deadline } from "../workflows/deadline.js";
import { codeRoute, step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import { CleanupResult, runCleanup, type CleanupInput } from "./cleanup.js";
import { FixTaskResult, FixerResult, FreezeResult, UnfreezeResult, mainRedRoutes, type MainRedWiring, type RedInput, type EpisodeInput } from "./main-red.js";
import type { ShepherdDeps } from "./phases.js";
import { REDEPLOY_STEP, redeployStep } from "./redeploy.js";
import { MAIN_CI_ROUTES, type MainCiRead, type MainCiRoute } from "./route-table.js";

export const SH_MAIN_CI_TIMEOUT_MS = 60 * 60_000;
export const SH_MAIN_CI_POLL_MS = 30_000;

/** Stages a merge may be followed by. This slice runs none of them; a non-empty list goes to the owner. */
export const AFTER_STAGES = ["deploy", "release", "activation"] as const;

export type AfterStage = (typeof AFTER_STAGES)[number];

export const POST_MERGE_STEPS: readonly StepDeclaration[] = [
  { id: "sh-main-ci", kind: "dispatch" },
  { id: REDEPLOY_STEP, kind: "dispatch" },
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
  /** Set when the verdict was read on a newer main push whose run superseded the merge sha's cancelled one. */
  readSha: z.string().optional(),
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
 * Reads main CI on the merge commit once and records it. Green redeploys the factory when the merge is into its own repo,
 * and may unfreeze the repo; red freezes it, files one fix task and spawns one fixer per episode; an unread main goes to
 * the owner. Then cleans up. Runs no after stage.
 */
export async function shepherdMainCi(ctx: WorkflowContext, target: MergedTarget, after: readonly AfterStage[], fixer = false): Promise<MainCi> {
  const result = await step(ctx, "sh-main-ci", { repo: target.repo, pr: target.pr, mergeSha: target.mergeSha, after }, MainCiResult);
  const red = { repo: target.repo, pr: target.pr, mergeSha: target.mergeSha, runId: ctx.runId };
  if (result.verdict === "green") {
    await redeployStep(ctx, { repo: target.repo, pr: target.pr, mergeSha: target.mergeSha });
    await onMainGreen(ctx, red);
  }
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
  const filed = await step(ctx, "sh-file-fix-task", episode, FixTaskResult);
  if (filed.thawed) return;
  if (filed.task === null) return askFrozen(ctx, "main-frozen", episode, `${where} The repo is frozen; no fix task was filed: ${filed.detail}. ${NO_FIXER_EXIT}`);
  const spawned = await step(ctx, "sh-spawn-fixer", { repo: red.repo, mergeSha: red.mergeSha, task: filed.task, fixer, episode: frozen.episode }, FixerResult);
  if (spawned.fixer === null && !spawned.thawed) await askFrozen(ctx, "main-frozen", episode, `${where} The repo is frozen with fix task ${filed.task}; no fixer was spawned: ${spawned.detail}. ${NO_FIXER_EXIT}`);
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
async function askFrozen(ctx: WorkflowContext, gate: "main-red-again" | "main-frozen", red: EpisodeInput, prompt: string): Promise<void> {
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
  /** The merged PR, read for its base branch; absent means a cancelled run is never followed to a newer push. */
  pr?: number;
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

type Read = { verdict: "green" | "red" | "pending"; detail: string } | { verdict: "newer"; sha: string; detail: string };

/** Polls until every run at the merge sha, or at the newer push that superseded it, has finished. A read error or the deadline is `none`, never green. */
export async function readMainCi(port: GitHubPort, input: MainCiInput, timing: Timing, signal: AbortSignal): Promise<MainCi> {
  const base = { mergeSha: input.mergeSha, after: input.after };
  if (input.mergeSha === "") return { ...base, verdict: "none", detail: "land returned no merge sha" };
  const clock = deadline(timing);
  let sha = input.mergeSha;
  let last = "no read yet";
  for (;;) {
    try {
      const read = await readAt(port, input, sha);
      if (read.verdict === "newer") sha = read.sha;
      else if (read.verdict !== "pending") return { ...base, ...(sha !== input.mergeSha && { readSha: sha }), verdict: read.verdict, detail: read.detail };
      last = read.detail;
    } catch (error) {
      last = failureOf(error);
    }
    if (clock.expired()) return { ...base, verdict: "none", detail: `no verdict after ${timing.timeoutMs} ms: ${last}` };
    await clock.sleep(timing.pollMs, signal);
  }
}

/** One read at `sha`, routed by MAIN_CI_ROUTES once it has finished. */
async function readAt(port: GitHubPort, input: MainCiInput, sha: string): Promise<Read> {
  const read = evaluate(sha, await port.checkRuns(input.repo, sha));
  if (read.verdict === "pending") return { verdict: "pending", detail: read.detail };
  const newer = read.verdict === "cancelled" ? await newerMainPush(port, input, sha) : undefined;
  const classified: Classified = newer === undefined ? { read: read.verdict } : { read: "cancelled-superseded", newer };
  const routed = routeOf(classified);
  switch (routed.route) {
    case "done":
      return { verdict: "green", detail: read.detail };
    case "main-red":
      return { verdict: "red", detail: read.detail };
    case "read-newer-run":
      return { verdict: "newer", sha: routed.newer, detail: `${read.detail} at ${sha}; reading the run at newer main push ${routed.newer}` };
  }
}

type MainCiTable = Readonly<Record<MainCiRead, MainCiRoute>>;

/** The reads a table sends to `read-newer-run`. */
type NewerRead<T extends MainCiTable> = { [K in MainCiRead]: T[K] extends "read-newer-run" ? K : never }[MainCiRead];

/**
 * A finished read carries a newer sha exactly when MAIN_CI_ROUTES sends it to `read-newer-run`, so a table edit that
 * routes a read with no newer sha there no longer type-checks where reads are classified.
 */
export type Classified<T extends MainCiTable = typeof MAIN_CI_ROUTES> =
  | { read: NewerRead<T>; newer: string }
  | { read: Exclude<MainCiRead, NewerRead<T>>; newer?: undefined };

type Routed = { route: "read-newer-run"; newer: string } | { route: Exclude<MainCiRoute, "read-newer-run"> };

function routeOf(classified: Classified): Routed {
  if (classified.newer === undefined) return { route: MAIN_CI_ROUTES[classified.read] };
  return { route: MAIN_CI_ROUTES[classified.read], newer: classified.newer };
}

/** The base branch's tip when it is a later push that contains `sha`, else undefined. */
async function newerMainPush(port: GitHubPort, input: MainCiInput, sha: string): Promise<string | undefined> {
  if (input.pr === undefined) return undefined;
  const { baseRef } = await port.getPr(input.repo, input.pr);
  const tip = await port.getHeadSha(input.repo, baseRef);
  if (tip === null || tip === sha) return undefined;
  return (await port.compareFiles(input.repo, sha, tip)).mergeBaseSha === sha ? tip : undefined;
}

type Evaluated = { verdict: Exclude<MainCiRead, "cancelled-superseded"> | "pending"; detail: string };

/** Only allowed-app runs at the merge sha count, and each counts, so an older red survives a newer green of its name. */
function evaluate(mergeSha: string, runs: readonly CheckRun[]): Evaluated {
  const counted = runs.filter((run) => run.headSha === mergeSha && run.appId === GITHUB_ACTIONS_APP_ID);
  if (counted.length === 0) return { verdict: "pending", detail: `no run from app ${GITHUB_ACTIONS_APP_ID} at ${mergeSha} yet` };
  const findings = headCheckFindings({ headSha: mergeSha, contexts: [], runs: counted, requiredApps: [GITHUB_ACTIONS_APP_ID] });
  const failed = findings.flatMap((finding) => (finding.kind === "failed" ? [finding.run] : []));
  const names = failed.map((run) => run.name).join(", ");
  if (failed.length > 0 && failed.every((run) => run.conclusion === "cancelled")) return { verdict: "cancelled", detail: `cancelled: ${names}` };
  if (failed.length > 0) return { verdict: "red", detail: `failed: ${names}` };
  if (findings.length > 0) return { verdict: "pending", detail: `still running: ${findings.map((finding) => (finding.kind === "missing" ? finding.name : finding.run.name)).join(", ")}` };
  return { verdict: "green", detail: `${counted.length} runs passed` };
}
