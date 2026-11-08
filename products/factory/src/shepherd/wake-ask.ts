import { DispatchError, type AgentRow } from "@titan-design/agent-dispatch";
import { BUMP_FIXER_ROUNDS, bumpRoundsSpent, fixerBrief } from "./bump-fixer.js";
import type { ShepherdDeps } from "./phases.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import { seatCheckout } from "./seat-checkout.js";
import { HEAD_LINE, wantsFreshFixer } from "./wake-brief.js";
import { latestRow, lineageSeat, successorName } from "./wake-roster.js";
import { rosterWhileBrokerDown, waitOf, type Wait } from "./wake-wait.js";
import { DEFAULT_WARMTH_LIMITS, isWarm, readWarmth } from "./warmth.js";
import { held, type ImplementerAgents, type WakeInput, type WakeStepResult, type WakeTask, type WakeWiring } from "./wake-types.js";

export function resumeMessage(task: WakeTask): string {
  const { input, pr } = task;
  const intro = `Shepherd is waking you on ${input.repo}#${input.pr}. ${task.reason}`;
  return `${intro}\n\n${task.payload}\n\nFix it on branch \`${pr.headRef}\`, push, and ${HEAD_LINE}`;
}

export type Choice =
  | { mode: "resume" | "live"; agent: string; message: string; sessionId: string }
  | { mode: "successor"; agent: string; predecessor: string; message: string; cwd: string };

/** A retired agent, one whose resume agent-chat refused this wake, or one a fresh-fixer wake passes over, is not asked again; a successor takes over. */
const resumable = (newest: AgentRow, refused: ReadonlySet<string>, input: WakeInput): boolean => newest.status !== "retired" && !refused.has(newest.name) && !wantsFreshFixer(input.payload);

/** A string is why nobody can be woken. */
export async function choose(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, newest: AgentRow, roster: readonly AgentRow[], refused: ReadonlySet<string>): Promise<Choice | string> {
  const path = newest.transcriptExists === true && newest.sessionId !== "" && resumable(newest, refused, task.input) ? newest.transcriptPath : null;
  const warmth = typeof path === "string" ? await (wiring.readWarmth ?? readWarmth)(path) : undefined;
  if (isWarm(warmth, deps.now(), wiring.limits ?? DEFAULT_WARMTH_LIMITS)) {
    return { mode: "resume", agent: newest.name, message: resumeMessage(task), sessionId: newest.sessionId };
  }
  return successorChoice(deps, wiring, task, newest.name, roster);
}

export function successorChoice(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, predecessor: string, roster: readonly AgentRow[]): Choice | string {
  if (deps.advisory?.(task.input.repo)) return `${task.input.repo} is advisory, so Shepherd starts no successor to push to it`;
  const checkout = resolveCheckout(task.input.repo, (wiring.checkoutFor ?? seatCheckout())(task.input.repo), wiring.home);
  if ("problem" in checkout) return `${checkout.problem}, so a successor has no checkout to start in`;
  if (task.bump && task.successors.length >= BUMP_FIXER_ROUNDS) return bumpRoundsSpent(task.successors.length);
  const agent = successorName(task, roster);
  return { mode: "successor", agent, predecessor, message: fixerBrief(task, predecessor, agent, lineageSeat(task, roster)), cwd: checkout.dir };
}

/** After a timeout the ask may have landed: a successor's name is on the roster, or the resumed agent is live again. A message leaves no mark. */
export function tookEffect(choice: Choice, roster: readonly AgentRow[]): boolean {
  const row = latestRow(choice.agent, roster);
  if (choice.mode === "live") return false;
  return choice.mode === "successor" ? row !== undefined : row !== undefined && row.presence !== "exited";
}

export function wokenBy(choice: Choice): Extract<WakeStepResult, { kind: "woken" }> {
  return { kind: "woken", agent: choice.agent, mode: choice.mode, ...(choice.mode !== "successor" && choice.sessionId !== "" && { sessionId: choice.sessionId }) };
}

/** A live agent is never resumed, because a second process would write its transcript; it is messaged instead. */
export const liveChoice = (task: WakeTask, live: AgentRow): Choice => ({ mode: "live", agent: live.name, message: resumeMessage(task), sessionId: live.sessionId });

export const sameAsk = (a: Choice | undefined, b: Choice): boolean => a !== undefined && a.mode === b.mode && a.agent === b.agent;

/**
 * The wait when the broker was down, the ask timed out or the spawn gate deferred it; any other failure is a refusal
 * and throws. A refusal of a re-ask is agent-chat refusing a duplicate once the earlier ask landed, so the roster decides.
 */
async function ask(deps: ShepherdDeps, agents: ImplementerAgents, choice: Choice, reask: boolean, signal: AbortSignal): Promise<true | Wait> {
  try {
    if (choice.mode === "successor") await agents.spawn(choice.agent, choice.message, choice.cwd);
    else await (choice.mode === "resume" ? agents.resume(choice.agent, choice.message) : agents.message(choice.agent, choice.message));
    return true;
  } catch (error) {
    const wait = waitOf(error);
    if (wait !== undefined) return wait;
    if (reask && tookEffect(choice, await rosterWhileBrokerDown(deps, agents, signal))) return true;
    throw error;
  }
}

/** What one ask came to: it was asked, it is waited out a poll, a successor is asked at once, or the step ends on a hold. */
type Sent = "asked" | Wait | "successor" | WakeStepResult;

/**
 * A resume agent-chat refuses, as of an agent on a model its pool no longer runs, is asked of a successor instead; a
 * refused successor is `held`, with the refusal named. Any other failure, and a refused message to a live agent, stays
 * a refusal: a successor beside a live agent would race it on the branch.
 */
export async function askOrFallBack(deps: ShepherdDeps, agents: ImplementerAgents, choice: Choice, reask: boolean, refused: Set<string>, signal: AbortSignal): Promise<Sent> {
  try {
    const sent = await ask(deps, agents, choice, reask, signal);
    return sent === true ? "asked" : sent;
  } catch (error) {
    signal.throwIfAborted();
    if (choice.mode === "live" || !(error instanceof DispatchError)) throw error;
    if (choice.mode === "successor") return held(choice.agent, error);
    refused.add(choice.agent);
    return "successor";
  }
}

/** A successor joins the run's lineage, so the next wake counts it; the broker's id is used once the roster shows it. */
export async function recordSuccessor(deps: ShepherdDeps, agents: ImplementerAgents, task: WakeTask, choice: Choice, signal: AbortSignal): Promise<void> {
  if (choice.mode !== "successor") return;
  const row = latestRow(choice.agent, await rosterWhileBrokerDown(deps, agents, signal));
  deps.store.get().recordAuthor(task.input.runId, { agentId: row?.agentId ?? choice.agent, name: choice.agent, role: "successor", predecessor: choice.predecessor });
}
