import { BrokerUnavailableError, parkAgent } from "@titan-design/agent-dispatch";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { redactForEvidence } from "../redact.js";
import { codeRoute, step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { freshReviewerBase } from "./cleanup.js";
import { liveRetry, rosterPresence, unrefWait, type LiveRetry, type ParkAttempt } from "./park-retry.js";
import type { ShepherdDeps } from "./phases.js";
import { agentChatRoster, type RosterReader } from "./roster.js";
import type { Registration, ShepherdStoreRef } from "./store.js";

export const PARK_STEP = "sh-park";
export const PARK_STEPS: readonly StepDeclaration[] = [{ id: PARK_STEP, kind: "dispatch" }];

/** Parks the named agent's worktree and keeps its branch; throws when the broker refuses or cannot be reached. */
export type ParkPort = (name: string) => Promise<{ lines: string[] }>;

export type ParkOutcome =
  | { kind: "parked"; agent: string; lines: string[]; alreadyGone?: true }
  | { kind: "not-parked"; agent: string; reason: string; brokerDown: boolean; retry?: "at-exit"; notice?: string }
  | { kind: "skipped"; reason: string };

interface ParkInput {
  runId: string;
  headSha: string;
  /** Reviewers an earlier park step recorded as gone; omitted when none, so a replayed record's input is unchanged. */
  gone?: string[];
}

const NOT_ON_DISK = /is not on disk; nothing to park/;
const NO_WORKTREE = /holds no worktree agent-chat allocated/;
const NO_AGENT = /no agent named/;
const LIVE = /park takes only an agent whose process has exited/;
const AGENT_CHAT_BRANCH = "agent-chat/";

/** A tree already removed, or one agent-chat never allocated, is the state parking wants; a live agent is asked again once it exits. */
async function attemptPark(park: ParkPort, agent: string): Promise<ParkOutcome> {
  try {
    return { kind: "parked", agent, lines: (await park(agent)).lines };
  } catch (error) {
    const reason = redactForEvidence(error instanceof Error ? error.message : String(error));
    if (NOT_ON_DISK.test(reason) || NO_WORKTREE.test(reason)) return { kind: "parked", agent, lines: [reason], alreadyGone: true };
    return { kind: "not-parked", agent, reason, brokerDown: error instanceof BrokerUnavailableError, ...(LIVE.test(reason) && { retry: "at-exit" as const }) };
  }
}

/**
 * Every name that may hold the run's tree, newest first: the successors the lineage records, the implementer, and the
 * agent an `agent-chat/<name>` branch was allocated to, which differs from the implementer when a seat registered the PR
 * under a name of its own.
 */
function parkCandidates(registration: Pick<Registration, "implementer" | "branch">, successors: readonly string[]): string[] {
  const branch = registration.branch;
  const allocatedTo = branch?.startsWith(AGENT_CHAT_BRANCH) ? [branch.slice(AGENT_CHAT_BRANCH.length)] : [];
  return [...new Set([...[...successors].reverse(), registration.implementer, ...allocatedTo])];
}

const unknownName = (outcome: ParkOutcome): boolean => outcome.kind === "not-parked" && NO_AGENT.test(outcome.reason);

/** Parks each candidate until the broker is down; a refusal outranks a park, so the run records what still holds a tree. */
async function parkAll(park: ParkPort, names: readonly string[]): Promise<ParkOutcome[]> {
  const outcomes: ParkOutcome[] = [];
  for (const name of names) {
    const outcome = await attemptPark(park, name);
    outcomes.push(outcome);
    if (outcome.kind === "not-parked" && outcome.brokerDown) break;
  }
  return outcomes;
}

function summarize(outcomes: readonly ParkOutcome[], names: readonly string[]): ParkOutcome {
  const known = outcomes.filter((outcome) => !unknownName(outcome));
  const refused = known.find((outcome) => outcome.kind === "not-parked");
  if (refused) return refused;
  const parked = known.filter((outcome) => outcome.kind === "parked");
  if (parked.length === 0) return { kind: "skipped", reason: `no agent on this broker is named ${names.join(", ")}; a retired agent's tree went with its retire` };
  return { kind: "parked", agent: parked.map((outcome) => outcome.agent).join(", "), lines: parked.flatMap((outcome) => outcome.lines), ...(parked.every((outcome) => outcome.alreadyGone) && { alreadyGone: true as const }) };
}

/** A refusal is an answer, not a failure: the tree stays and the run moves on to review. */
export async function parkImplementer(store: ShepherdStoreRef, park: ParkPort, input: ParkInput): Promise<ParkOutcome> {
  const registration = store.get().byRun(input.runId);
  if (!registration?.implementer) return { kind: "skipped", reason: "no registration names the implementer" };
  const successors = store.get().authorsOf(input.runId).filter((author) => author.role === "successor").map((author) => author.name);
  const names = parkCandidates(registration, successors);
  const outcomes = await parkAll(park, names);
  return summarize(outcomes, names);
}

/** The seat that owns the run's policy, or the hub seat when the policy names none or a joined pair. */
function noticeSeat(ports: ExitNoticePorts, registration: Registration): string | undefined {
  const seat = registration.policy.seat;
  return seat !== "none" && !seat.includes("+") ? seat : ports.hubSeat?.();
}

/** One line per tree left standing; never throws, and records whether the line went out. */
async function tellParkRefusal(ports: ExitNoticePorts | undefined, registration: Registration | undefined, agent: string, reason: string): Promise<string> {
  if (ports === undefined || registration === undefined) return "unsent: no seat notice is wired";
  const seat = noticeSeat(ports, registration);
  if (seat === undefined) return "unsent: the policy names no single seat and no hub seat is set";
  const target = registration.pr === null ? registration.branch ?? registration.runId : `${registration.repo}#${registration.pr}`;
  try {
    await ports.send(seat, `Shepherd: ${target}: ${agent}'s worktree was not parked: ${reason}`);
    return `sent to ${seat}`;
  } catch (error) {
    return `unsent: ${failureOf(error)}`;
  }
}

interface ParkWiring {
  park: ParkPort;
  roster?: RosterReader;
  notice?: ExitNoticePorts;
  retry?: LiveRetry;
}

/** An agent retired while the retry waited took its tree with it: nothing is left to park, so the seat is not told. */
const asAttempt = (outcome: ParkOutcome): ParkAttempt => {
  if (outcome.kind !== "not-parked") return { done: true, parked: true, detail: outcome.kind };
  if (NO_AGENT.test(outcome.reason)) return { done: true, parked: true, detail: "already gone" };
  return outcome.retry ? { done: false } : { done: true, parked: false, detail: outcome.reason };
};

/** Waits out a live agent in the background, and tells the seat only if the tree still stands at the end. */
function armRetry(store: ShepherdStoreRef, wiring: ParkWiring, runId: string, agent: string): void {
  void wiring.retry?.arm(agent, async (settled) => {
    if (!settled.parked) await tellParkRefusal(wiring.notice, store.get().byRun(runId), agent, settled.detail);
  });
}

/** What a round's end did to the tree of a reviewer that is no longer running. */
type ReviewerPark = ParkOutcome;

/** Shepherd's own reviewers of this PR that have exited; a running one is a running round, and the standing reviewer is never Shepherd's to park. */
async function exitedReviewers(roster: RosterReader, registration: Registration): Promise<string[]> {
  const read = await roster.read();
  if (read.kind === "unknown" || registration.pr === null) return [];
  const own = new RegExp(`^${freshReviewerBase(registration.repo, registration.pr)}(-\\d+)?$`);
  const exited = read.rows.filter((row) => own.test(row.name) && row.presence === "exited" && row.status !== "retired" && row.name !== registration.policy.reviewer);
  return [...new Set(exited.map((row) => row.name))];
}

/** A reviewer the broker no longer knows has no tree left to park, the same answer as a tree off disk. */
function settleRetired(outcome: ParkOutcome): ParkOutcome {
  return outcome.kind === "not-parked" && NO_AGENT.test(outcome.reason) ? { kind: "parked", agent: outcome.agent, lines: [outcome.reason], alreadyGone: true } : outcome;
}

/** A finished round leaves its reviewer's tree behind; a refusal is told to the seat loudly and asked again at the next round end. */
async function parkReviewers(store: ShepherdStoreRef, wiring: ParkWiring, runId: string, gone: readonly string[]): Promise<ReviewerPark[]> {
  const registration = store.get().byRun(runId);
  if (wiring.roster === undefined || registration === undefined) return [];
  const names = (await exitedReviewers(wiring.roster, registration).catch(() => [])).filter((name) => !gone.includes(name));
  const outcomes: ReviewerPark[] = [];
  for (const name of names) outcomes.push(settleRetired(await attemptPark(wiring.park, name)));
  for (const outcome of outcomes) {
    if (outcome.kind !== "not-parked") continue;
    console.error(`shepherd: ${registration.repo}#${registration.pr}: reviewer ${outcome.agent}'s worktree was not parked: ${outcome.reason}`);
    await tellParkRefusal(wiring.notice, registration, outcome.agent, outcome.reason);
  }
  return outcomes;
}

/** Parks, then either arms the exit retry or tells the seat; the step records which, with the round's reviewers. */
export async function parkStep(store: ShepherdStoreRef, wiring: ParkWiring, input: ParkInput): Promise<ParkOutcome & { reviewers: ReviewerPark[] }> {
  const reviewers = await parkReviewers(store, wiring, input.runId, input.gone ?? []);
  const outcome = await parkImplementer(store, wiring.park, input);
  if (outcome.kind !== "not-parked") return { ...outcome, reviewers };
  if (outcome.retry) return (armRetry(store, wiring, input.runId, outcome.agent), { ...outcome, reviewers });
  return { ...outcome, reviewers, notice: await tellParkRefusal(wiring.notice, store.get().byRun(input.runId), outcome.agent, outcome.reason) };
}

/** The serve process's one retry, so a restart's replay re-arms what the step before it armed. */
let rearm: ((runId: string, agent: string) => void) | undefined;

/** Only what parking reads, so a test wires it without a GitHub port. */
type ParkDeps = Pick<ShepherdDeps, "store" | "now" | "agentChatBin" | "roster" | "exitNotice">;

function rosterRetry(deps: ParkDeps, park: ParkPort): LiveRetry {
  const roster = deps.roster ?? agentChatRoster(deps.agentChatBin);
  return liveRetry({ attempt: async (name) => asAttempt(await attemptPark(park, name)), presence: rosterPresence(roster), wait: unrefWait, now: deps.now });
}

export const parkRoutes = (deps: ParkDeps, park: ParkPort = (name) => parkAgent(deps.agentChatBin, name), retry: LiveRetry = rosterRetry(deps, park)): readonly StepRoute[] => {
  const wiring: ParkWiring = { park, roster: deps.roster ?? agentChatRoster(deps.agentChatBin), notice: deps.exitNotice, retry };
  rearm = (runId, agent) => armRetry(deps.store, wiring, runId, agent);
  return [codeRoute(PARK_STEP, deps.now, async (input: ParkInput) => parkStep(deps.store, wiring, input))];
};

const GoneReviewer = z.looseObject({ kind: z.literal("parked"), agent: z.string(), alreadyGone: z.literal(true) });
const ParkOutcomeResult = z.looseObject({ kind: z.enum(["parked", "not-parked", "skipped"]), reviewers: z.array(z.unknown()).optional() });
const LiveRefusal = z.looseObject({ kind: z.literal("not-parked"), agent: z.string(), retry: z.literal("at-exit") });

/** A first run's refusal is already armed and ignored here; a replayed one is armed again, since the restart lost its wait. */
export function rearmRecorded(runId: string, recorded: unknown): void {
  const live = LiveRefusal.safeParse(recorded);
  if (live.success) rearm?.(runId, live.data.agent);
}

/**
 * Reviewers a recorded park step found gone, per run context. A restart replays the run's steps and rebuilds this from
 * their recorded results, so no round end after the first asks the broker about a reviewer again.
 */
const goneByContext = new WeakMap<object, Set<string>>();

/** Runs one park step with the gone reviewers known so far and folds the ones its record adds back in. */
export async function parkOnce(key: object, runStep: (gone: string[] | undefined) => Promise<z.infer<typeof ParkOutcomeResult>>): Promise<z.infer<typeof ParkOutcomeResult>> {
  const gone = goneByContext.get(key) ?? new Set<string>();
  goneByContext.set(key, gone);
  const recorded = await runStep(gone.size > 0 ? [...gone] : undefined);
  for (const reviewer of recorded.reviewers ?? []) {
    const parsed = GoneReviewer.safeParse(reviewer);
    if (parsed.success) gone.add(parsed.data.agent);
  }
  return recorded;
}

/** Once per green head, before its review: a fix round's resume re-creates the tree, so the next green head parks it again. */
export async function parkAtGreen(ctx: WorkflowContext, headSha: string): Promise<void> {
  const run = (gone: string[] | undefined) => step(ctx, `${PARK_STEP}:${headSha}`, { runId: ctx.runId, headSha, ...(gone && { gone }) }, ParkOutcomeResult);
  rearmRecorded(ctx.runId, await parkOnce(ctx, run));
}
