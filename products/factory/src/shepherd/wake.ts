import { isAbsolute } from "node:path";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { awaitNewHeadRoute } from "../workflows/await-head.js";
import { codeRoute } from "../workflows/land.js";
import { FIXER_EXIT_STEPS, fixerExitRoutes } from "./flake-check.js";
import { FIX_PROOF_WAKE_STEP } from "./fix-proof-cap.js";
import { successorConfigDir, successorSpawnAccounts } from "./account-hold.js";
import { noteFixerLimit } from "./fixer-limit.js";
import { agentChatAgents, type AgentChatAgents, type SpawnAccounts } from "./agents.js";
import type { ShepherdDeps } from "./phases.js";
import { failureOf } from "./error-class.js";
import { bumpFacts, isConsumerBumpRun } from "./bump-fixer.js";
import type { Registration } from "./store.js";
import { FIX_FIRST_STEP, REPAIR_STEP, describeWake, isRefName, withMergeBaseException } from "./wake-brief.js";
import { exitedOn } from "./wake-roster.js";
import { HOLDING_KINDS } from "./held-wake.js";
import { messagePredecessor, noticeSpawner } from "./wake-notice.js";
import { wakeAgent } from "./wake-loop.js";
import { WakeInputSchema, unhandled, type ImplementerAgents, type WakeInput, type WakeStepResult, type WakeTask, type WakeWiring } from "./wake-types.js";
import { hostLockRegenRoute } from "./closure-regen-host.js";

export type { ImplementerAgents, WakeInput, WakeStepResult, WakeWiring } from "./wake-types.js";

export const WAKE_STEP = "sh-wake-implementer";
export const AWAIT_NEW_HEAD_STEP = "sh-await-new-head";
export const WAKE_STEPS: readonly StepDeclaration[] = [
  { id: WAKE_STEP, kind: "dispatch" },
  { id: AWAIT_NEW_HEAD_STEP, kind: "dispatch" },
  { id: FIX_FIRST_STEP, kind: "dispatch" },
  { id: REPAIR_STEP, kind: "dispatch" },
  { id: FIX_PROOF_WAKE_STEP, kind: "dispatch" },
  ...FIXER_EXIT_STEPS,
];

/** The agent-chat profile Shepherd's fixers and successors start under; the profile is their tool grant. It is headless because no one watches a pane for them, and the builtin `implementer` opens one. */
export const FACTORY_IMPLEMENTER_PROFILE = "bd-implementer";

/** `accounts` is read per spawn; absent leaves the adapter's own account with no fallback. */
export const implementersOver = (agents: AgentChatAgents, accounts: () => SpawnAccounts = () => ({})): ImplementerAgents => ({
  ...agents,
  spawn: (name, brief, cwd) => agents.spawn({ name, profile: FACTORY_IMPLEMENTER_PROFILE, brief, cwd, ...accounts() }),
});

async function wakeTask(deps: ShepherdDeps, input: WakeInput, registration: Registration): Promise<WakeTask | string> {
  const pr = await deps.port.getPr(input.repo, input.pr);
  if (pr.state !== "open") return `${input.repo}#${input.pr} is no longer open`;
  if (!isRefName(pr.headRef)) return `the head branch name of ${input.repo}#${input.pr} is not one a brief can carry`;
  if (!isRefName(pr.baseRef)) return `the base branch name of ${input.repo}#${input.pr} is not a valid ref name`;
  const successors = deps.store.get().authorsOf(input.runId).filter((author) => author.role === "successor").map((author) => author.name);
  const bump = isConsumerBumpRun(registration) ? { bump: await bumpFacts(deps.port, registration, pr, input.pr) } : {};
  return { input, pr, ...(await describeWake(deps.port, withMergeBaseException(input, deps.store), pr, deps.suiteRules?.fixer)), implementer: registration.implementer, successors, ...bump };
}

function agentsFor(deps: ShepherdDeps, wiring: WakeWiring): ImplementerAgents | undefined {
  return wiring.agents ?? (isAbsolute(deps.agentChatBin) ? implementersOver(agentChatAgents(deps.agentChatBin, { configDir: successorConfigDir(deps), roster: deps.roster, gate: deps.spawnGate }), () => successorSpawnAccounts(deps)) : undefined);
}

/** Never throws but for an abort: a refusal or a failed read is `unhandled`, so the run falls back to the owner gate; a `held` one tells the seat first. */
async function wakeImplementer(deps: ShepherdDeps, wiring: WakeWiring, input: WakeInput, signal: AbortSignal): Promise<WakeStepResult> {
  const agents = agentsFor(deps, wiring);
  if (agents === undefined) return unhandled("shepherd.agentChatBin is not configured");
  try {
    const registration = deps.store.get().byRun(input.runId);
    if (registration === undefined) return unhandled(`run ${input.runId} has no shepherd registration`);
    if (!registration.policy.fixer) return unhandled("seat grants no fixer");
    const task = await wakeTask(deps, input, registration);
    if (typeof task === "string") return unhandled(task);
    const woke = await wakeAgent(deps, wiring, agents, task, signal).catch((error: unknown) => refusedWake(error, signal));
    return tellSpawner(deps, agents, task, await tellHeld(agents, task, heldOnlyIfHolding(input.kind, woke), signal), signal);
  } catch (error) {
    return refusedWake(error, signal);
  }
}

function refusedWake(error: unknown, signal: AbortSignal): WakeStepResult {
  signal.throwIfAborted();
  return unhandled(`the wake was refused: ${failureOf(error)}`);
}

/** A held wake's seat is told by its own route; the lineage's newest agent is messaged its findings now. */
async function tellHeld(agents: ImplementerAgents, task: WakeTask, result: WakeStepResult, signal: AbortSignal): Promise<WakeStepResult> {
  if (result.kind !== "unhandled" || result.held === undefined) return result;
  const predecessor = await messagePredecessor(agents, task, result.reason, signal);
  return { ...result, predecessor };
}

/** A held wake's seat is told by its own route. */
async function tellSpawner(deps: ShepherdDeps, agents: ImplementerAgents, task: WakeTask, result: WakeStepResult, signal: AbortSignal): Promise<WakeStepResult> {
  if (result.kind !== "unhandled" || result.held !== undefined || deps.exitNotice === undefined) return result;
  return { ...result, notice: await noticeSpawner(deps.exitNotice, () => agents.roster(), task, result.reason, signal) };
}

/** The step's record is what `wakePhase` and the view both read, so a kind that never holds records no `held`. */
function heldOnlyIfHolding(kind: WakeInput["kind"], result: WakeStepResult): WakeStepResult {
  return result.kind === "unhandled" && result.held !== undefined && !HOLDING_KINDS.has(kind) ? unhandled(result.reason) : result;
}

/** A malformed input fails the step; the await step reads and never writes, so each repeats safely after a crash. */
export const wakeRoutes = (deps: ShepherdDeps, wiring: WakeWiring = {}): readonly StepRoute[] => [
  codeRoute(WAKE_STEP, deps.now, async (raw: unknown, signal) => wakeImplementer(deps, wiring, WakeInputSchema.parse(raw), signal)),
  awaitNewHeadRoute({ ...deps, agentExited: exitedOn(agentsFor(deps, wiring), noteFixerLimit(deps)) }, AWAIT_NEW_HEAD_STEP),
  codeRoute(FIX_FIRST_STEP, deps.now, async (input: object) => input),
  codeRoute(REPAIR_STEP, deps.now, async (input: object) => input),
  codeRoute(FIX_PROOF_WAKE_STEP, deps.now, async (input: object) => input),
  ...fixerExitRoutes(deps.port, deps.now, deps.exitNotice),
  hostLockRegenRoute(deps),
];
