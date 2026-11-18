import type { AgentRow } from "@titan-design/agent-dispatch";
import type { GitHubPort } from "@titan-design/github";
import { failureOf } from "./error-class.js";
import { headMoved, unreadableHead, type HeadRead } from "./head-read.js";
import type { ShepherdDeps } from "./phases.js";
import { latestRow, newestAgent } from "./wake-roster.js";
import { retireHung, type Hung } from "./wake-hung.js";
import { TURN_START_MS, awaitTurn, transcriptTurnSince } from "./turn-check.js";
import { deadlineFor, expiredWait, rosterWhileBrokerDown, waitAPoll, whileDeferred, type Waiting } from "./wake-wait.js";
import { readWarmth } from "./warmth.js";
import { askOrFallBack, choose, liveChoice, recordSuccessor, resumeMessage, sameAsk, successorChoice, tookEffect, wokenBy, type Choice } from "./wake-ask.js";
import { unhandled, type Fallback, type ImplementerAgents, type Mode, type WakeInput, type WakeStepResult, type WakeTask, type WakeWiring } from "./wake-types.js";

const DEFAULT_POLL_MS = 30_000;

/**
 * The woken agent must start a turn within `turnStartMs`. If it does not, one fallback ask goes out: a resume if it has
 * ended by then, else a direct message. No turn after that leaves the wake unhandled, so the run does not wait on nobody,
 * unless a live agent ignored both asks and was retired, which `hung` reports so a successor is started.
 */
async function confirmTurn(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, asked: Asked, signal: AbortSignal): Promise<WakeStepResult | Hung> {
  await recordSuccessor(deps, agents, task, asked.choice, signal);
  const woke = { ...wokenBy(asked.choice), askedAt: asked.at };
  if (await awaitTurn(turnWatch(deps, wiring, agents, task, asked.choice.agent, signal), asked.at, signal)) return woke;
  const roster = await rosterWhileBrokerDown(deps, agents, signal);
  const fallback: Fallback = latestRow(asked.choice.agent, roster)?.presence === "exited" ? "resume" : "message";
  const at = deps.now();
  try {
    const again = () => (fallback === "resume" ? agents.resume(asked.choice.agent, resumeMessage(task)) : agents.message(asked.choice.agent, resumeMessage(task)));
    await whileDeferred(deps, deadlineFor(wiring, "deferred"), signal, again);
  } catch (error) {
    return unhandled(`${asked.choice.agent} started no turn after the wake, and the ${fallback} fallback failed: ${failureOf(error)}`);
  }
  if (await awaitTurn(turnWatch(deps, wiring, agents, task, asked.choice.agent, signal), at, signal)) return { ...woke, fallback, askedAt: at };
  const stalled = `${asked.choice.agent} started no turn within ${(wiring.turnStartMs ?? TURN_START_MS) / 60_000} minutes of the wake or of the ${fallback} fallback`;
  if (asked.choice.mode !== "live" || fallback !== "message") return unhandled(stalled);
  const replaceable = typeof successorChoice(deps, wiring, task, asked.choice.agent, await rosterWhileBrokerDown(deps, agents, signal)) !== "string";
  return retireHung(agents, asked.choice.agent, replaceable, stalled, signal);
}

function turnWatch(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, name: string, signal: AbortSignal) {
  return {
    now: deps.now,
    sleep: deps.sleep,
    pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
    timeoutMs: wiring.turnStartMs ?? TURN_START_MS,
    row: async () => latestRow(name, await rosterWhileBrokerDown(deps, agents, signal)),
    prMovedOn: () => prMovedOn(deps.port, task.input),
    turnSince: wiring.turnSince ?? transcriptTurnSince(wiring.readWarmth ?? readWarmth),
  };
}

interface Asked {
  choice: Choice;
  /** Epoch milliseconds, so only a turn after the ask counts. */
  at: number;
}

const ASK_VERB: Record<Mode, string> = { resume: "resume", successor: "spawn", live: "message" };

/** An ask that never lands, as a resume of a parked tree that times out each time, fails the wake once the deadline passes. */
function askExpired(deps: ShepherdDeps, wiring: WakeWiring, asked: Asked | undefined, waiting: Waiting | undefined): WakeStepResult | undefined {
  if (asked === undefined || waiting === undefined) return undefined;
  const within = expiredWait(deps, deadlineFor(wiring, waiting.wait), waiting);
  return within === undefined ? undefined : unhandled(`${asked.choice.agent}'s ${ASK_VERB[asked.choice.mode]} took no effect within ${within}`);
}

async function prMovedOn(port: GitHubPort, input: WakeInput): Promise<boolean> {
  const pr = await port.getPr(input.repo, input.pr).catch(() => undefined);
  return pr !== undefined && (pr.headSha !== input.headSha || pr.state !== "open");
}

/**
 * A new head pushed by anyone, as by a live agent that took the wake itself or after the implementer exited, needs no ask, so the run advances (TP-5171); an unreadable PR defers the
 * ask a poll under its own deadline, so the ask deadline restarts after it. A lineage gone from the roster still has the
 * repo's checkout, so a successor takes over from the registered implementer (TP-4045), as it does from a live agent
 * retired for ignoring the wake and its fallback (TP-4430).
 */
export async function wakeAgent(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, signal: AbortSignal): Promise<WakeStepResult> {
  const loop: WakeLoop = { refused: new Set<string>() };
  const unreadable = unreadableHead(deps, task.input, signal);
  for (;;) {
    const roster = await rosterWhileBrokerDown(deps, agents, signal);
    const { asked } = loop;
    const settled = settle(loop, asked && tookEffect(asked.choice, roster) ? await confirmTurn(deps, wiring, agents, task, asked, signal) : askExpired(deps, wiring, asked, loop.waiting));
    if (settled !== undefined) return settled;
    const newest = newestAgent(task, roster);
    const read: HeadRead = await headMoved(deps.port, task.input);
    if ("error" in read) {
      const gaveUp = await unreadable.failed(read.error);
      if (gaveUp !== undefined) return unhandled(gaveUp);
      loop.waiting = undefined;
      continue;
    }
    unreadable.read();
    if (read.moved) return newest !== undefined ? wokenBy(liveChoice(task, newest)) : { kind: "woken", agent: task.implementer, mode: "live" };
    const choice = await nextChoice(deps, wiring, task, roster, newest, loop);
    if (typeof choice === "string") return unhandled(choice);
    const done = await askOnce(deps, wiring, agents, task, choice, loop, signal);
    if (done !== undefined) return done;
  }
}

interface WakeLoop {
  asked?: Asked;
  waiting?: Waiting;
  refused: Set<string>;
  /** The live agent retired for taking no wake; from then on only its successor is asked. */
  hung?: string;
}

/** A retired hung agent sends the loop round again to start its successor; anything else settles the wake. */
function settle(loop: WakeLoop, result: WakeStepResult | Hung | undefined): WakeStepResult | undefined {
  if (result?.kind !== "hung") return result;
  loop.hung = result.agent;
  loop.asked = loop.waiting = undefined;
  return undefined;
}

async function nextChoice(deps: ShepherdDeps, wiring: WakeWiring, task: WakeTask, roster: readonly AgentRow[], newest: AgentRow | undefined, loop: WakeLoop): Promise<Choice | string> {
  if (loop.hung !== undefined) return successorChoice(deps, wiring, task, loop.hung, roster);
  if (newest === undefined) return successorChoice(deps, wiring, task, task.implementer, roster);
  return newest.presence !== "exited" ? liveChoice(task, newest) : choose(deps, wiring, task, newest, roster, loop.refused);
}

/** One ask and what follows it: a settled wake, or undefined to go round again after a wait, a fallback or a retire. */
async function askOnce(deps: ShepherdDeps, wiring: WakeWiring, agents: ImplementerAgents, task: WakeTask, choice: Choice, loop: WakeLoop, signal: AbortSignal): Promise<WakeStepResult | undefined> {
  const reask = sameAsk(loop.asked?.choice, choice);
  const asked: Asked = { choice, at: deps.now() };
  loop.asked = asked;
  const sent = await askOrFallBack(deps, agents, choice, reask, loop.refused, signal);
  if (sent === "asked") return settle(loop, await confirmTurn(deps, wiring, agents, task, asked, signal));
  if (typeof sent === "object") return sent;
  if (sent !== "successor") loop.waiting = await waitAPoll(deps, { since: loop.waiting?.since ?? asked.at, wait: sent }, signal);
  return undefined;
}
