import { dataFence } from "@titan-design/agent-dispatch";
import { isPassing, latestPerName, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { deadline } from "../workflows/deadline.js";
import { failureOf } from "./error-class.js";
import type { FreezeStore } from "./freeze.js";
import { THAWED, failedTests, failingLogs, patiently, type EpisodeInput, type FailingRead, type FixTasks, type FlakeFields, type MainRedWiring } from "./main-red.js";
import type { ShepherdDeps } from "./phases.js";
import { tailBytes } from "./wake-brief.js";

/** How long Shepherd waits for its rerun of main's failed jobs before the episode goes on to a fixer. */
export const SH_MAIN_RERUN_TIMEOUT_MS = 60 * 60_000;
/** A failing test that thawed on a rerun within this window freezes the normal way: a known flake gets a fix, not a reroll. */
export const FLAKE_REPEAT_MS = 24 * 60 * 60_000;
export const FLAKE_TAG = "flake";
export const MAIN_RERUN_STEP = "sh-main-rerun";
const EXCERPT_BYTES = 4_000;

/** `thawed` means the episode is over, by this rerun or by anything else while the step ran. */
export const RerunResult = z.looseObject({ thawed: z.boolean(), detail: z.string() });
type Rerun = z.infer<typeof RerunResult>;

export interface RerunInput extends EpisodeInput {
  /** The episode's fix task, `<initiative>/<id>`, which a thaw turns into the flake task. */
  task: string;
}

/** The red at the episode's red sha that a rerun may clear: its failing jobs, their tests, and the port that files the flake. */
interface Red {
  freezes: FreezeStore;
  markFlake: NonNullable<FixTasks["markFlake"]>;
  episode: number;
  read: FailingRead;
  tests: string[];
}

const stays = (detail: string): Rerun => ({ thawed: false, detail });

/**
 * Reruns the failed jobs at the red sha once per episode (decision 525). Only Shepherd's own rerun counts: each red job
 * must come back green in a run newer than every check run at the sha before the rerun. A green rerun files the flake on
 * the fix task, which stays open, and only then thaws. A failing test that thawed this way within 24 h stays frozen.
 */
export async function rerunRedMain(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: RerunInput, signal: AbortSignal): Promise<Rerun> {
  const all = await deps.port.checkRuns(input.repo, input.mergeSha);
  const newest = Math.max(0, ...all.map((run) => run.id));
  const red = await redToRerun(deps, wiring, input, all, newest);
  if ("thawed" in red) return red;
  const claim = red.freezes.claimRerun(input.repo, red.episode, input.runId, newest);
  if (claim === undefined) return red.freezes.live(input.repo, red.episode) ? stays("this episode's one rerun was already spent") : { thawed: true, detail: THAWED };
  if (claim.fresh) {
    const queued = await queueRerun(deps.port, input.repo, red.read.failing);
    if (queued !== undefined) return stays(queued);
  }
  const reran = await awaitRerun(deps, red, input, claim.after, signal);
  if ("thawed" in reran) return reran;
  return thawOnFlake(deps, red, input, reran.green, signal);
}

/**
 * The red as it stood before the episode's rerun: each check's newest run no later than the claim's bound, else `newest`,
 * so a restarted step still reads the red its own green rerun has since superseded.
 */
async function redBefore(deps: ShepherdDeps, freezes: FreezeStore, input: RerunInput, all: readonly CheckRun[], newest: number): Promise<FailingRead> {
  const bound = freezes.rerunClaim(input.repo, input.episode!)?.after ?? newest;
  return failingLogs(deps.port, input.repo, input.mergeSha, latestPerName(all.filter((run) => run.headSha === input.mergeSha && run.id <= bound)));
}

/** The red this episode may rerun, or why it may not. */
async function redToRerun(deps: ShepherdDeps, wiring: MainRedWiring | undefined, input: RerunInput, all: readonly CheckRun[], newest: number): Promise<Red | Rerun> {
  const freezes = wiring?.freezes();
  const live = freezes?.live(input.repo, input.episode);
  if (!freezes || !live) return { thawed: true, detail: THAWED };
  if (live.cancelOnly) return stays("a red of cancels only thaws on a later run of its own");
  if (live.redSha !== input.mergeSha) return stays(`the episode's red moved on to ${live.redSha}`);
  const tasks = wiring?.tasks;
  if (tasks?.markFlake === undefined) return stays("no active-work port can file the flake task, so main is not rerun");
  const read = await redBefore(deps, freezes, input, all, newest);
  if (read.failing.length === 0) return stays(`no job is red at ${input.mergeSha} any more, and only Shepherd's own rerun thaws at the red sha`);
  const tests = failedTests(read.log);
  if (tests.length === 0) return stays("the failing jobs name no failing test, so main is not rerun");
  if (read.failing.some((run) => run.workflowRunId === null)) return stays("a failing check has no Actions run to rerun");
  const since = new Date(deps.now() - FLAKE_REPEAT_MS).toISOString();
  const repeats = new Set(freezes.rerunThawedTests(input.repo, since));
  const again = tests.filter((test) => repeats.has(test));
  if (again.length > 0) return stays(`${again.join(", ")} already thawed main on a rerun within 24 h, so it stays frozen for a real fix`);
  return { freezes, markFlake: (initiative, id, flake) => tasks.markFlake!(initiative, id, flake), episode: live.episode, read, tests };
}

/** Undefined once every red job's Actions run is queued again; otherwise why not, which leaves the repo frozen. */
async function queueRerun(port: GitHubPort, repo: RepoSlug, failing: readonly CheckRun[]): Promise<string | undefined> {
  try {
    for (const runId of new Set(failing.map((run) => run.workflowRunId!))) {
      const result = await port.rerunFailed(repo, runId);
      if (!result.done) return `the rerun of Actions run ${runId} was not queued: ${result.skipped ?? "refused"}`;
    }
    return undefined;
  } catch (error) {
    return `the rerun could not be queued: ${failureOf(error)}`;
  }
}

/** Each red job's first run after `after`, once all have finished green; a red one, a thaw or the time limit ends the wait. */
async function awaitRerun(deps: ShepherdDeps, red: Red, input: RerunInput, after: number, signal: AbortSignal): Promise<{ green: CheckRun[] } | Rerun> {
  const clock = deadline({ now: deps.now, sleep: deps.sleep, timeoutMs: SH_MAIN_RERUN_TIMEOUT_MS });
  const names = [...new Set(red.read.failing.map((run) => run.name))];
  for (;;) {
    if (!red.freezes.live(input.repo, red.episode)) return { thawed: true, detail: THAWED };
    const ours = await rerunsAfter(deps.port, input, names, after).catch(() => undefined);
    if (ours !== undefined && ours.every((run) => run.status === "completed")) {
      const failed = ours.filter((run) => !isPassing(run)).map((run) => run.name);
      return failed.length === 0 ? { green: ours } : stays(`the rerun at ${input.mergeSha} failed again: ${failed.join(", ")}`);
    }
    if (clock.expired()) return stays(`the rerun at ${input.mergeSha} did not finish within ${SH_MAIN_RERUN_TIMEOUT_MS / 60_000} min`);
    await clock.sleep(deps.pollMs ?? 30_000, signal);
  }
}

/** Per name, the oldest check run newer than `after`, which is the one Shepherd's rerun queued; undefined until each has one. */
async function rerunsAfter(port: GitHubPort, input: RerunInput, names: readonly string[], after: number): Promise<CheckRun[] | undefined> {
  const runs = (await port.checkRuns(input.repo, input.mergeSha)).filter((run) => run.headSha === input.mergeSha && run.id > after);
  const ours = names.flatMap((name) => runs.filter((run) => run.name === name).sort((a, b) => a.id - b.id).slice(0, 1));
  return ours.length === names.length ? ours : undefined;
}

/** The flake goes on the fix task first; a task that cannot be updated keeps the repo frozen, so no flake thaws unrecorded. */
async function thawOnFlake(deps: ShepherdDeps, red: Red, input: RerunInput, green: readonly CheckRun[], signal: AbortSignal): Promise<Rerun> {
  const at = input.task.indexOf("/");
  const [initiative, id] = [input.task.slice(0, at), input.task.slice(at + 1)];
  const fields = flakeFields(input, red, green);
  const marked = await patiently(deps, signal, () => red.markFlake(initiative, id, fields));
  if ("error" in marked) return stays(`active-work did not take the flake task: ${marked.error}`);
  if (!red.freezes.thawOnRerun(input.repo, red.episode, red.tests)) return { thawed: true, detail: `${THAWED} after the flake was filed on ${input.task}` };
  return { thawed: true, detail: `thawed on Shepherd's green rerun at ${input.mergeSha}; flake filed on ${input.task}` };
}

const runLine = (run: CheckRun): string => `- ${run.name}: Actions run ${run.workflowRunId ?? "none"}, job ${run.id}, ${run.url}`;

export function flakeFields(input: RerunInput, red: Pick<Red, "episode" | "read" | "tests">, green: readonly CheckRun[]): FlakeFields {
  const notes = [
    `Flake (episode ${red.episode}, ${input.mergeSha}): main CI on ${input.repo} went red, and Shepherd's own rerun of the failed jobs passed at the same sha, so the freeze thawed. The test still fails intermittently; this task stays open until its cause is fixed.`,
    ["Red run:", ...red.read.failing.map(runLine)].join("\n"),
    ["Green rerun:", ...green.map(runLine)].join("\n"),
    ["Failing tests:", ...red.tests.map((test) => `- ${test}`)].join("\n"),
    dataFence("error excerpt", tailBytes(red.read.log, EXCERPT_BYTES)),
  ].join("\n\n");
  const done_when = `The root cause of the flaky failure of ${red.tests.join(", ")} on ${input.repo} is found and fixed, so the test passes deterministically. A retry, a longer timeout or a quarantine does not count.`;
  return { done_when, notes, tag: FLAKE_TAG };
}
