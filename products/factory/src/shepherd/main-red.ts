import { BrokerUnavailableError, DispatchTimeoutError, dataFence } from "@titan-design/agent-dispatch";
import { GITHUB_ACTIONS_APP_ID, isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { deadline } from "../workflows/deadline.js";
import { codeRoute } from "../workflows/land.js";
import { greenAfterRed, redOnlyFromCancels, type FreezeStore } from "./freeze.js";
import type { AgentChatAgents } from "./agents.js";
import type { ShepherdDeps } from "./phases.js";
import { failureOf } from "./error-class.js";
import { SpawnDeferred } from "./spawn-gate.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import { LOG_BUDGET_BYTES, LOG_TAIL_LINES, tailBytes } from "./wake-brief.js";
import { GITHUB_READ_GIVE_UP_MS } from "./timeouts.js";
import { FACTORY_IMPLEMENTER_PROFILE, seatCheckout } from "./wake.js";

/** How long a down active-work daemon or agent-chat broker is waited out before the step gives the red main to the owner. */
export const SH_MAIN_RED_GIVE_UP_MS = GITHUB_READ_GIVE_UP_MS;
export const SH_MAIN_RED_POLL_MS = 30_000;
/** Where a fix task goes when the merged PR's registration names no `<initiative>/<id>` task. */
export const DEFAULT_FIX_INITIATIVE = "titan-platform";

export interface FixTaskFields {
  title: string;
  severity: "high";
  done_when: string;
  tags: string[];
  notes: string;
}

/** The active-work calls `sh-file-fix-task` makes; the lookup by tag is what makes a repeated add a no-op. */
export interface FixTasks {
  findByTag(initiative: string, tag: string): Promise<string | undefined>;
  add(initiative: string, fields: FixTaskFields): Promise<string>;
}

/** A broker that is down or a timeout is waited out; any other throw is a refusal. */
export interface FixerAgents {
  roster(): Promise<readonly { name: string }[]>;
  spawn(name: string, brief: string, cwd: string): Promise<void>;
}

/** Absent ports leave the red main with the owner: the repo still freezes, and nothing is filed or spawned. */
export interface MainRedWiring {
  freezes: () => FreezeStore;
  tasks?: FixTasks;
  fixers?: FixerAgents;
  /** The repo's main checkout, which the fixer's worktree is cut from; defaults to the repo's seat path. */
  checkoutFor?: (repo: string) => string | undefined;
  home?: string;
}

/** A spawn invalidates `roster`, so a retried spawn checks a fresh roster for the fixer it may already have started. */
export const fixersOver = (agents: AgentChatAgents): FixerAgents => ({
  roster: () => agents.roster(),
  spawn: (name, brief, cwd) => agents.spawn({ name, profile: FACTORY_IMPLEMENTER_PROFILE, brief, cwd }),
});

const slug = (part: string | undefined): string => (part ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** The idempotency key of one red main: the repo and the merge sha that turned it red. */
export function mainRedKey(repo: RepoSlug, mergeSha: string): string {
  const [owner, name] = repo.split("/");
  return `main-red:${slug(owner) || "owner"}-${slug(name) || "repo"}-${mergeSha.toLowerCase().slice(0, 12)}`;
}

/** Deterministic, so a crash between the spawn and its record finds the same fixer on the roster. */
export function fixerName(repo: RepoSlug, mergeSha: string): string {
  return `fix-${slug(repo.split("/")[1]) || "repo"}-${mergeSha.toLowerCase().slice(0, 7)}`;
}

export const FreezeResult = z.looseObject({
  state: z.enum(["new", "again", "unwired"]),
  fixTask: z.string().nullable(),
  fixer: z.string().nullable(),
  episode: z.number().nullable(),
});

/** `thawed` means the episode ended while the step ran, so there is nothing left to gate on. */
export const FixTaskResult = z.looseObject({ task: z.string().nullable(), thawed: z.boolean(), detail: z.string() });
export const FixerResult = z.looseObject({ fixer: z.string().nullable(), thawed: z.boolean(), detail: z.string() });
/** `frozen` is whether the repo is still frozen after the step. */
export const UnfreezeResult = z.looseObject({ unfrozen: z.boolean(), frozen: z.boolean(), episode: z.number().nullable(), detail: z.string() });

export interface RedInput {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
  runId: string;
}

/** The episode `sh-freeze` returned; a step that finds another episode live writes nothing. */
export interface EpisodeInput extends RedInput {
  episode: number | null;
}

export interface FixerInput {
  repo: RepoSlug;
  mergeSha: string;
  task: string;
  /** The run's policy grant; false means notify only. */
  fixer: boolean;
  episode: number | null;
}

/** `again` when the live freeze already has a fixer, so this red came from the fixer's own merge or through it, and the owner decides. */
export function freezeStep(wiring: MainRedWiring | undefined, input: Pick<RedInput, "repo" | "mergeSha">, cancelOnly = false): z.infer<typeof FreezeResult> {
  if (!wiring) return { state: "unwired", fixTask: null, fixer: null, episode: null };
  const freezes = wiring.freezes();
  const again = (freezes.get(input.repo)?.fixer ?? null) !== null;
  const frozen = freezes.freeze(input.repo, input.mergeSha, cancelOnly);
  return { state: again ? "again" : "new", fixTask: frozen.fixTask, fixer: frozen.fixer, episode: frozen.episode, redCount: frozen.redCount };
}

type Patient<T> = { value: T } | { error: string };

/** Retries any throw until the give-up deadline, so a daemon that is down delays the step and never fails it. */
async function patiently<T>(deps: ShepherdDeps, signal: AbortSignal, attempt: () => Promise<T>, retryable: (error: unknown) => boolean = () => true): Promise<Patient<T>> {
  const clock = deadline({ now: deps.now, sleep: deps.sleep, timeoutMs: SH_MAIN_RED_GIVE_UP_MS });
  for (;;) {
    try {
      return { value: await attempt() };
    } catch (error) {
      if (!retryable(error) || clock.expired()) return { error: failureOf(error) };
    }
    await clock.sleep(deps.pollMs ?? SH_MAIN_RED_POLL_MS, signal);
  }
}

/** The failing Actions jobs at `sha` with their log tails, split evenly so one noisy job cannot crowd out the rest. */
export async function failingLogs(port: GitHubPort, repo: RepoSlug, sha: string): Promise<{ failing: CheckRun[]; log: string }> {
  const runs = await port.latestCheckRuns(repo, sha).catch(() => [] as CheckRun[]);
  const failing = runs.filter((run) => run.headSha === sha && run.appId === GITHUB_ACTIONS_APP_ID && run.status === "completed" && !isPassing(run));
  if (failing.length === 0) return { failing, log: "No failing Actions run was found at this sha." };
  const budget = Math.floor(LOG_BUDGET_BYTES / failing.length);
  const sections = await Promise.all(failing.map(async (run) => {
    const header = `== ${run.name} (${run.conclusion ?? "no conclusion"}) ${run.url}\n`;
    const log = await port.jobLogTail(repo, run.id, LOG_TAIL_LINES).catch((error: unknown) => `(log unavailable: ${failureOf(error)})`);
    return header + tailBytes(log, Math.max(0, budget - Buffer.byteLength(header) - 1));
  }));
  return { failing, log: sections.join("\n") };
}

/** `<initiative>/<id>` of the merged PR's registration; anything else files into the default initiative. */
function initiativeOf(task: string | undefined): string | undefined {
  const initiative = task?.split("/")[0];
  return task !== undefined && task.includes("/") && /^[a-z0-9][a-z0-9-]*$/i.test(initiative ?? "") ? initiative : undefined;
}

async function fixTaskFields(deps: ShepherdDeps, input: RedInput, key: string, fallback: boolean): Promise<FixTaskFields> {
  const { failing, log } = await failingLogs(deps.port, input.repo, input.mergeSha);
  const short = input.mergeSha.slice(0, 7);
  const jobs = failing.map((run) => run.name).join(", ") || "no failing job read";
  const notes = [
    `Shepherd filed this when main CI went red on ${input.repo} after #${input.pr} merged as ${input.mergeSha}. Merges into the repo are frozen until main is green. Key: ${key}.`,
    ...(fallback ? [`The merged PR's registration named no <initiative>/<id> task, so this was filed into ${DEFAULT_FIX_INITIATIVE}.`] : []),
    ...failing.map((run) => `- ${run.name}: ${run.url}`),
    dataFence("CI log", log),
  ].join("\n\n");
  return { title: `main red on ${input.repo} at ${short}: ${jobs}`.slice(0, 200), severity: "high", done_when: `Main CI on ${input.repo} is green at a commit after ${short}.`, tags: ["shepherd", "main-red", key], notes };
}

const noTask = (detail: string, thawed = false): z.infer<typeof FixTaskResult> => ({ task: null, thawed, detail });

/** One task per episode: the freeze row's task is reused, and an add that landed before a crash is found again by its key tag. */
export async function fileFixTask(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: EpisodeInput, signal: AbortSignal): Promise<z.infer<typeof FixTaskResult>> {
  const live = wiring?.freezes().live(input.repo, input.episode);
  if (!wiring || !live) return noTask(THAWED, true);
  if (live.fixTask !== null) return { task: live.fixTask, thawed: false, detail: "this episode already has its fix task" };
  const tasks = wiring.tasks;
  if (!tasks) return noTask("no active-work port is wired");
  const named = initiativeOf(deps.store.get().byRun(input.runId)?.task);
  const initiative = named ?? DEFAULT_FIX_INITIATIVE;
  const key = mainRedKey(input.repo, input.mergeSha);
  const fields = await fixTaskFields(deps, input, key, named === undefined);
  const id = await patiently(deps, signal, async () => {
    if (!wiring.freezes().live(input.repo, input.episode)) return undefined;
    return (await tasks.findByTag(initiative, key)) ?? (await tasks.add(initiative, fields));
  });
  if ("error" in id) return noTask(`active-work did not take the fix task: ${id.error}`);
  if (id.value === undefined) return noTask(THAWED, true);
  const task = `${initiative}/${id.value}`;
  if (!wiring.freezes().setFixTask(input.repo, live.episode, task)) return { task, thawed: true, detail: `${THAWED} after ${task} was filed` };
  return { task, thawed: false, detail: "filed" };
}

function fixerBrief(name: string, input: FixerInput, failing: readonly CheckRun[], log: string): string {
  return [
    `You are ${name}, Shepherd's fixer for a red main on ${input.repo}. Main CI went red at merge ${input.mergeSha}, and Shepherd froze merges into the repo. Only a PR registered against the fix task ${input.task} with you as its implementer may merge until main is green.`,
    dataFence("failing jobs", failing.map((run) => run.name).join("\n") || "none read"),
    dataFence("CI log", log),
    `Branch from the latest origin main, fix the failure, and push. Open a PR, then register it with Shepherd (\`titan-factory shepherd register\`) with task \`${input.task}\` and implementer \`${name}\`. Report the PR and end with a line \`Head: <full sha>\` naming the head you pushed.`,
  ].join("\n\n");
}

const brokerDown = (error: unknown): boolean => error instanceof BrokerUnavailableError || error instanceof DispatchTimeoutError || error instanceof SpawnDeferred;

const THAWED = "the episode thawed while the step ran";

const noFixer = (detail: string, thawed = false): z.infer<typeof FixerResult> => ({ fixer: null, thawed, detail });

/** One fixer per episode: the freeze row's fixer is reused, and a name already on the roster is never spawned twice. */
export async function spawnFixer(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: FixerInput, signal: AbortSignal): Promise<z.infer<typeof FixerResult>> {
  if (!input.fixer) return noFixer("notify only: the policy grants no fixer");
  const live = wiring?.freezes().live(input.repo, input.episode);
  if (!wiring || !live) return noFixer(THAWED, true);
  if (live.fixer !== null) return { fixer: live.fixer, thawed: false, detail: "this episode already has its fixer" };
  const fixers = wiring.fixers;
  if (!fixers) return noFixer("no agent-chat is configured to spawn a fixer");
  const checkout = resolveCheckout(input.repo, (wiring.checkoutFor ?? seatCheckout())(input.repo), wiring.home);
  if ("problem" in checkout) return noFixer(`${checkout.problem}, so a fixer has no checkout to start in`);
  const name = fixerName(input.repo, input.mergeSha);
  const { failing, log } = await failingLogs(deps.port, input.repo, input.mergeSha);
  const brief = fixerBrief(name, input, failing, log);
  const spawned = await patiently(deps, signal, async () => {
    if (!wiring.freezes().live(input.repo, input.episode)) return false;
    if (!(await fixers.roster()).some((row) => row.name === name)) await fixers.spawn(name, brief, checkout.dir);
    return true;
  }, brokerDown);
  if ("error" in spawned) return noFixer(`spawning ${name} failed: ${spawned.error}`);
  if (!spawned.value) return noFixer(THAWED, true);
  if (!wiring.freezes().setFixer(input.repo, live.episode, name)) return { fixer: name, thawed: true, detail: `${THAWED} after ${name} was spawned` };
  return { fixer: name, thawed: false, detail: "spawned" };
}

/** A green merge clears the freeze only if it descends from the red sha and re-ran green every check that was red there. */
export async function unfreezeStep(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: Pick<RedInput, "repo" | "pr" | "mergeSha">): Promise<z.infer<typeof UnfreezeResult>> {
  const freezes = wiring?.freezes();
  const live = freezes?.get(input.repo);
  if (!freezes || !live) return { unfrozen: false, frozen: false, episode: null, detail: "the repo is not frozen" };
  const stays = (detail: string) => ({ unfrozen: false, frozen: true, episode: live.episode, detail });
  try {
    const after = (await deps.port.compareFiles(input.repo, live.redSha, input.mergeSha)).mergeBaseSha === live.redSha;
    if (!after) return stays(`${input.mergeSha} does not descend from the red sha ${live.redSha}`);
    const { baseRef } = await deps.port.getPr(input.repo, input.pr);
    if (!(await greenAfterRed(deps.port, input.repo, input.mergeSha, live, baseRef))) return stays(`a check red at ${live.redSha} has not run green at ${input.mergeSha}`);
  } catch (error) {
    return stays(`main could not be read: ${failureOf(error)}`);
  }
  const unfrozen = freezes.unfreeze(input.repo, input.mergeSha);
  return { unfrozen, frozen: freezes.isFrozen(input.repo), episode: live.episode, detail: "green after the red sha" };
}

/** A read that fails records an ordinary red, which only a later green sha clears. */
const cancelOnlyAt = (port: GitHubPort, input: RedInput): Promise<boolean> => redOnlyFromCancels(port, input.repo, input.mergeSha).catch(() => false);

export function mainRedRoutes(deps: ShepherdDeps, wiring: MainRedWiring | undefined): StepRoute[] {
  return [
    codeRoute("sh-freeze", deps.now, async (input: RedInput) => freezeStep(wiring, input, wiring !== undefined && (await cancelOnlyAt(deps.port, input)))),
    codeRoute("sh-file-fix-task", deps.now, (input: EpisodeInput, signal) => fileFixTask(deps, wiring, input, signal)),
    codeRoute("sh-spawn-fixer", deps.now, (input: FixerInput, signal) => spawnFixer(deps, wiring, input, signal)),
    codeRoute("sh-unfreeze", deps.now, (input: RedInput) => unfreezeStep(deps, wiring, input)),
    codeRoute("sh-thaw", deps.now, async (input: EpisodeInput) => ({ thawed: input.episode !== null && (wiring?.freezes().release(input.repo, input.episode) ?? false) })),
  ];
}
