import { BrokerUnavailableError, DispatchTimeoutError, dataFence } from "@titan-design/agent-dispatch";
import type { CheckRun, GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { deadline } from "../workflows/deadline.js";
import { codeRoute } from "../workflows/land.js";
import { greenAfterRed, redOnlyFromCancels, type Freeze, type FreezeStore } from "./freeze.js";
import type { AgentChatAgents, SpawnAccounts } from "./agents.js";
import type { ShepherdDeps } from "./phases.js";
import { recordAutoPass } from "./auto-pass.js";
import { successorSpawnAccounts } from "./account-hold.js";
import { failureOf } from "./error-class.js";
import { DEFAULT_FIX_INITIATIVE, initiativeOf } from "./fix-initiative.js";
import { SpawnDeferred } from "./spawn-gate.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import { failedTests, failingLogs, sameFailure, type FailingRead } from "./main-red-logs.js";
import { GITHUB_READ_GIVE_UP_MS } from "./timeouts.js";
import { seatCheckout } from "./seat-checkout.js";
import { FACTORY_IMPLEMENTER_PROFILE } from "./wake.js";

/** How long a down active-work daemon or agent-chat broker is waited out before the step gives the red main to the owner. */
export const SH_MAIN_RED_GIVE_UP_MS = GITHUB_READ_GIVE_UP_MS;
export const SH_MAIN_RED_POLL_MS = 30_000;

export const MAIN_RERUN_STEP = "sh-main-rerun";

/** The dispatch steps of a red or green main, in the order a run reaches them. */
const MAIN_RED_STEP_IDS = ["sh-unfreeze", "sh-freeze", "sh-file-fix-task", MAIN_RERUN_STEP, "sh-spawn-fixer", "sh-thaw"];
export const MAIN_RED_STEPS: readonly StepDeclaration[] = MAIN_RED_STEP_IDS.map((id) => ({ id, kind: "dispatch" as const }));

export interface FixTaskFields {
  title: string;
  severity: "high";
  done_when: string;
  tags: string[];
  notes: string;
}

/** Active-work refused the call itself, which no retry changes; any other throw from `FixTasks` is an outage to wait out. */
export class FixTaskRefused extends Error {
  override readonly name = "FixTaskRefused";
}

export const notRefused = (error: unknown): boolean => !(error instanceof FixTaskRefused);

/** The active-work calls `sh-file-fix-task` makes; the lookup by tag is what makes a repeated add a no-op. */
export interface FixTasks {
  findByTag(initiative: string, tag: string): Promise<string | undefined>;
  add(initiative: string, fields: FixTaskFields): Promise<string>;
  /** Turns a filed fix task into a flake task: replaces its done_when, adds `tag`, reopens it, then appends `notes` once. Absent means no rerun thaw. */
  markFlake?(initiative: string, id: string, flake: FlakeFields): Promise<void>;
}

export interface FlakeFields {
  done_when: string;
  notes: string;
  tag: string;
}

/** A broker that is down or a timeout is waited out; any other throw is a refusal. */
export interface FixerAgents {
  /** `presence` is `live` while a session holds the name. */
  roster(): Promise<readonly { name: string; presence?: string }[]>;
  /** `accounts` is the account picked for this spawn and its fallbacks; absent means agent-chat's default. */
  spawn(name: string, brief: string, cwd: string, accounts?: SpawnAccounts): Promise<void>;
  /** Retires a fixer spawned for an episode that recorded another one meanwhile; absent leaves it to the ended-fixer sweep. */
  retire?(name: string): Promise<void>;
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
  spawn: (name, brief, cwd, accounts) => agents.spawn({ name, profile: FACTORY_IMPLEMENTER_PROFILE, brief, cwd, ...accounts }),
  ...(agents.retire && { retire: agents.retire.bind(agents) }),
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
  /** Optional, so a step result recorded before the field existed still parses on replay. */
  fixPr: z.number().nullable().optional(),
});

/** `thawed` means the episode ended while the step ran, so there is nothing left to gate on. */
export const FixTaskResult = z.looseObject({ task: z.string().nullable(), thawed: z.boolean(), detail: z.string() });
/** `fixPr` is the seat's PR marked as the episode's fix, which stands in for Shepherd's own fixer. */
export const FixerResult = z.looseObject({ fixer: z.string().nullable(), fixPr: z.number().nullable().optional(), thawed: z.boolean(), detail: z.string() });
/** `frozen` is whether the repo is still frozen after the step. */
export const UnfreezeResult = z.looseObject({ unfrozen: z.boolean(), frozen: z.boolean(), episode: z.number().nullable(), detail: z.string() });

/** What a red or unread main gate would have named. */
export interface MainRedAbout {
  repo: RepoSlug;
  pr: number;
  mergeSha: string;
  headline: string;
  detail: string;
}

/** D13 (TP-3697): the red or unread main as an FYI record with its evidence; nothing waits on the owner. */
export async function mainRedFyi(ctx: WorkflowContext, situation: string, about: MainRedAbout): Promise<void> {
  const evidence = [`merge sha: ${about.mergeSha === "" ? "none returned" : about.mergeSha}`, `main CI read: ${about.detail}`, `run: ${ctx.runId}`];
  const headSha = about.mergeSha === "" ? "no-merge-sha" : about.mergeSha;
  await recordAutoPass(ctx, { repo: about.repo, pr: about.pr, rule: "D13/main-red-fyi", headSha, detail: `${about.headline}. ${situation}`, evidence });
}

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

/** `again` when the live freeze already has a fixer or a marked fix PR, so this red came from that fix's merge or through it, and the owner decides. */
export function freezeStep(wiring: MainRedWiring | undefined, input: Pick<RedInput, "repo" | "mergeSha">, cancelOnly = false): z.infer<typeof FreezeResult> {
  if (!wiring) return { state: "unwired", fixTask: null, fixer: null, episode: null, fixPr: null };
  const freezes = wiring.freezes();
  const before = freezes.get(input.repo);
  const again = (before?.fixer ?? null) !== null || (before?.fixPr ?? null) !== null;
  const frozen = freezes.freeze(input.repo, input.mergeSha, cancelOnly);
  return { state: again ? "again" : "new", fixTask: frozen.fixTask, fixer: frozen.fixer, episode: frozen.episode, fixPr: frozen.fixPr, redCount: frozen.redCount };
}

type Patient<T> = { value: T } | { error: string };

/** Retries any throw until the give-up deadline, so a daemon that is down delays the step and never fails it. */
export async function patiently<T>(deps: ShepherdDeps, signal: AbortSignal, attempt: () => Promise<T>, retryable: (error: unknown) => boolean = () => true): Promise<Patient<T>> {
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

/** A fixer from an earlier episode that still stands: running on the roster, or with its registered PR still open. */
interface StandingFix {
  fixer: string;
  task: string;
  redSha: string;
  pr: number | null;
}

/** Each earlier episode's first red sha, newest first; the fixer an episode spawns is named after that sha. */
function earlierReds(deps: ShepherdDeps, input: EpisodeInput): string[] {
  const shas = deps.store.get().eventsOf(input.runId).flatMap((event) => (event.kind === "freeze" && event.pr === null && event.headSha !== null ? [event.headSha] : []));
  return [...new Set(shas.reverse())].filter((sha) => sha !== input.mergeSha);
}

async function openFixPr(deps: ShepherdDeps, repo: RepoSlug, fixer: string): Promise<{ task: string; pr: number } | undefined> {
  const registration = deps.store.get().all().filter((row) => row.repo.toLowerCase() === repo.toLowerCase() && row.implementer === fixer && row.pr !== null).at(-1);
  if (registration === undefined || registration.pr === null) return undefined;
  const pr = await deps.port.getPr(repo, registration.pr);
  return pr.state === "open" ? { task: registration.task, pr: registration.pr } : undefined;
}

/** The task a live fixer without a PR was briefed with, found by its red's key in the initiatives a fix task is filed into. */
async function briefedTask(tasks: FixTasks, initiative: string, key: string): Promise<string | undefined> {
  for (const where of new Set([initiative, DEFAULT_FIX_INITIATIVE])) {
    const id = await tasks.findByTag(where, key);
    if (id !== undefined) return `${where}/${id}`;
  }
  return undefined;
}

async function standingAt(deps: ShepherdDeps, wiring: MainRedWiring, repo: RepoSlug, redSha: string, live: ReadonlySet<string>, initiative: string): Promise<StandingFix | undefined> {
  const fixer = fixerName(repo, redSha);
  const open = await openFixPr(deps, repo, fixer);
  if (open !== undefined) return { fixer, redSha, ...open };
  if (!live.has(fixer) || !wiring.tasks) return undefined;
  const task = await briefedTask(wiring.tasks, initiative, mainRedKey(repo, redSha));
  return task === undefined ? undefined : { fixer, redSha, task, pr: null };
}

/** The standing fixer of an earlier red that failed the same way as this one, so one flaky test keeps one fixer. */
async function standingFix(deps: ShepherdDeps, wiring: MainRedWiring, input: EpisodeInput, initiative: string, now: FailingRead): Promise<StandingFix | undefined> {
  if (!wiring.fixers || failedTests(now.log).length === 0) return undefined;
  const live = new Set((await wiring.fixers.roster()).filter((row) => row.presence === "live").map((row) => row.name));
  for (const redSha of earlierReds(deps, input)) {
    const standing = await standingAt(deps, wiring, input.repo, redSha, live, initiative);
    if (standing !== undefined && sameFailure(now, await failingLogs(deps.port, input.repo, redSha))) return standing;
  }
  return undefined;
}

/**
 * Hands this episode the standing fixer and its task, so its PR passes this freeze and `sh-spawn-fixer` reuses it. A
 * fixer, task or fix PR the episode gained while the standing fixer was looked up is kept, so its exemption never moves.
 */
function linkStanding(wiring: MainRedWiring, input: EpisodeInput, episode: number, standing: StandingFix): z.infer<typeof FixTaskResult> | undefined {
  const linked = wiring.freezes().episodes.linkFix(input.repo, episode, standing.task, standing.fixer);
  if (linked === "not-live") return noTask(THAWED, true);
  if (linked === "kept") {
    const kept = wiring.freezes().live(input.repo, episode)?.fixTask ?? null;
    return kept === null ? undefined : { task: kept, thawed: false, detail: `kept the episode's own fix task; ${standing.fixer} was not linked` };
  }
  const pr = standing.pr === null ? "" : ` and its open PR #${standing.pr}`;
  return { task: standing.task, thawed: false, detail: `linked to ${standing.fixer}${pr}: the red at ${standing.redSha} failed the same checks and tests` };
}

function fixTaskFields(input: RedInput, read: FailingRead, key: string, fallback: boolean): FixTaskFields {
  const { failing, log } = read;
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

/**
 * One task per episode: the freeze row's task is reused, and an add that landed before a crash is found again by its key
 * tag. A standing fixer of an earlier red with the same failing checks and tests lends its task and name instead.
 */
export async function fileFixTask(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: EpisodeInput, signal: AbortSignal): Promise<z.infer<typeof FixTaskResult>> {
  const live = wiring?.freezes().live(input.repo, input.episode);
  if (!wiring || !live) return noTask(THAWED, true);
  if (live.fixTask !== null) return { task: live.fixTask, thawed: false, detail: "this episode already has its fix task" };
  const tasks = wiring.tasks;
  if (!tasks) return noTask("no active-work port is wired");
  const named = initiativeOf(deps.store.get().byRun(input.runId)?.task);
  const initiative = named ?? DEFAULT_FIX_INITIATIVE;
  const key = mainRedKey(input.repo, input.mergeSha);
  const read = await failingLogs(deps.port, input.repo, input.mergeSha);
  const standing = await standingFix(deps, wiring, input, initiative, read).catch(() => undefined);
  const linked = standing && linkStanding(wiring, input, live.episode, standing);
  if (linked !== undefined) return linked;
  const fields = fixTaskFields(input, read, key, named === undefined);
  const id = await patiently(deps, signal, async () => {
    if (!wiring.freezes().live(input.repo, input.episode)) return undefined;
    return (await tasks.findByTag(initiative, key)) ?? (await tasks.add(initiative, fields));
  }, notRefused);
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
    FLAKE_FIX_REGISTER,
  ].join("\n\n");
}

/** Mirrors TP-3987's TEST_ONLY_HINT: `proceedsOnNoRepro` lets only a spec-free test-only PR past a vacuous fix-proof. */
const FLAKE_FIX_REGISTER =
  "If the failure is a flaky test and your fix changes only tests, register the PR with `--kind test-only` and add no `<test>.mutations.json`: with noReproProceed on, its vacuous fix-proof goes on to review, and any mutation spec keeps it NO_REPRO. The red may also thaw on Shepherd's rerun while you work; the task then holds both runs, and its done_when still asks for a root-cause fix, never a retry, a longer timeout or a quarantine.";

const brokerDown = (error: unknown): boolean => error instanceof BrokerUnavailableError || error instanceof DispatchTimeoutError || error instanceof SpawnDeferred;

export const THAWED = "the episode thawed while the step ran";

const noFixer = (detail: string, thawed = false): z.infer<typeof FixerResult> => ({ fixer: null, thawed, detail });

/** The fixer or marked fix PR the live episode already has, which this step reuses instead of spawning. */
function episodeFix(live: Freeze): z.infer<typeof FixerResult> | undefined {
  if (live.fixer !== null) return { fixer: live.fixer, thawed: false, detail: "this episode already has its fixer" };
  if (live.fixPr !== null) return { fixer: null, fixPr: live.fixPr, thawed: false, detail: `seat fix PR #${live.fixPr} is marked for this episode` };
  return undefined;
}

/**
 * One fixer per episode: the freeze row's fixer is reused, a name already on the roster is never spawned twice, and a
 * marked fix PR means none is spawned. The fixer is named from the episode's first red, so every run that reaches this
 * step for the episode agrees on one name, and the row is read again right before the spawn.
 */
export async function spawnFixer(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: FixerInput, signal: AbortSignal): Promise<z.infer<typeof FixerResult>> {
  if (!input.fixer) return noFixer("notify only: the policy grants no fixer");
  if (deps.advisory?.(input.repo)) return noFixer(`notify only: ${input.repo} is advisory, so Shepherd starts no fixer to push to it`);
  const live = wiring?.freezes().live(input.repo, input.episode);
  if (!wiring || !live) return noFixer(THAWED, true);
  const standing = episodeFix(live);
  if (standing) return standing;
  const fixers = wiring.fixers;
  if (!fixers) return noFixer("no agent-chat is configured to spawn a fixer");
  const checkout = resolveCheckout(input.repo, (wiring.checkoutFor ?? seatCheckout())(input.repo), wiring.home);
  if ("problem" in checkout) return noFixer(`${checkout.problem}, so a fixer has no checkout to start in`);
  const redSha = wiring.freezes().episodes.firstRed(input.repo, live.episode) ?? live.redSha;
  const name = fixerName(input.repo, redSha);
  const { failing, log } = await failingLogs(deps.port, input.repo, redSha);
  const spawn = () => fixers.spawn(name, fixerBrief(name, { ...input, mergeSha: redSha }, failing, log), checkout.dir, successorSpawnAccounts(deps));
  const current = () => wiring.freezes().live(input.repo, input.episode);
  const spawned = await patiently(deps, signal, () => spawnUnlessTaken(fixers, name, current, spawn), brokerDown);
  if ("error" in spawned) return noFixer(`spawning ${name} failed: ${spawned.error}`);
  if (!spawned.value) return noFixer(THAWED, true);
  const taken = episodeFix(spawned.value);
  if (taken) return taken;
  if (wiring.freezes().setFixer(input.repo, live.episode, name)) return { fixer: name, thawed: false, detail: "spawned" };
  const kept = current()?.fixer;
  if (kept == null) return { fixer: name, thawed: true, detail: `${THAWED} after ${name} was spawned` };
  return { fixer: kept, thawed: false, detail: await retireExtraFixer(fixers, name, kept) };
}

/** Undefined once the episode thawed. The row is read again after the roster, the slow part, so a fixer recorded meanwhile is never joined by a second one. */
async function spawnUnlessTaken(fixers: FixerAgents, name: string, current: () => Freeze | undefined, spawn: () => Promise<void>): Promise<Freeze | undefined> {
  if (!current()) return undefined;
  const onRoster = (await fixers.roster()).some((row) => row.name === name);
  const live = current();
  if (live && !episodeFix(live) && !onRoster) await spawn();
  return live;
}

/** A concurrent step recorded its fixer between this spawn and its record; the recorded one keeps the exemption. */
async function retireExtraFixer(fixers: FixerAgents, extra: string, kept: string): Promise<string> {
  const lost = `the episode already had ${kept} when ${extra} was spawned`;
  if (!fixers.retire) return `${lost}; no retire is wired, so ${extra} stays`;
  return fixers.retire(extra).then(() => `${lost}; retired ${extra}`, (error: unknown) => `${lost}; retiring ${extra} failed: ${failureOf(error)}`);
}

/** A green merge clears the freeze only if it descends from the red sha and re-ran green every check that was red there. */
export async function unfreezeStep(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: Pick<RedInput, "repo" | "pr" | "mergeSha">): Promise<z.infer<typeof UnfreezeResult>> {
  const freezes = wiring?.freezes();
  const live = freezes?.get(input.repo);
  if (!freezes || !live) return { unfrozen: false, frozen: false, episode: null, detail: "the repo is not frozen" };
  // A thaw elsewhere during the reads already ran its sweep, so a frozen answer read before them strands the gate (TP-2919).
  const stays = (detail: string) => {
    const frozen = freezes.live(input.repo, live.episode) !== undefined;
    return { unfrozen: false, frozen, episode: live.episode, detail: frozen ? detail : `${detail}; episode ${live.episode} thawed meanwhile` };
  };
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
    codeRoute("sh-thaw", deps.now, async (input: EpisodeInput) => ({ thawed: input.episode !== null && (wiring?.freezes().release(input.repo, input.episode, "owner") ?? false) })),
  ];
}
