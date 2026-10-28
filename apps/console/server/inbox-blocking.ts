/**
 * Which inbox items block running work, as one rule per source (TP-4352). An item is blocking only when data it already
 * carries shows something live waits on the answer: a hitl gate its live run is pending on at a PR head, a deposit or
 * agent-chat question whose asker is live (or whose op names a live head), or an open round. Morning is frozen
 * (decision 530) and an active-work task waits on nobody, so neither is ever blocking. A source the console cannot read
 * a fact for stays non-blocking rather than guessing.
 */
import { LIVE_HISTORY_STATES, type AgentRosterSnapshot } from "@titan-design/chat-protocol/agents";
import type { OwnerItem, OwnerOp } from "@titan-design/owner-queue";
import type { ShepherdSource } from "./shepherd.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

export type InboxSection = "blocking" | "planning";

interface BlockingFacts {
  /** The live Shepherd row the item's gate or op joins, when it joins one. */
  row: WatchRow | undefined;
  /** Names of agents the broker sees live; undefined when the roster was not read, so no asker can be called live. */
  liveAgents: ReadonlySet<string> | undefined;
}

const REPLAY_DIVERGED = /^replay diverged/;
/** Closing a PR or retiring an agent tidies up; nothing running waits on it. */
const CLEANUP_OPS: ReadonlySet<OwnerOp["kind"]> = new Set(["close-pr", "retire-agent"]);

const askedAsBlocking = (item: OwnerItem): boolean => item.lens.startsWith("blocking-") || item.lens === "stuck";

/** Live means the broker has presence for it, or its history says the process may still run. */
export function liveAgentNames(roster: AgentRosterSnapshot): Set<string> {
  const live: readonly string[] = LIVE_HISTORY_STATES;
  return new Set(roster.agents.filter((agent) => agent.stateSource === "presence" || live.includes(agent.state)).map((agent) => agent.name));
}

const pinnedLive = (row: WatchRow | undefined): row is WatchRow & { pr: number; headSha: string } =>
  row !== undefined && row.pr !== null && row.headSha !== null && !REPLAY_DIVERGED.test(row.stalled?.reason ?? "");

/** The run itself must be pending on this gate at a PR head; a rowless or diverged gate unblocks nothing. */
function gateBlocks(gateId: string, row: WatchRow | undefined): boolean {
  return pinnedLive(row) && row.pendingGate?.gateId.toLowerCase() === gateId.toLowerCase();
}

const atHead = (row: WatchRow | undefined, headSha: string): boolean => pinnedLive(row) && row.headSha.toLowerCase() === headSha.toLowerCase();

/** An op naming a PR head blocks only at the live run's head; undefined leaves the call to the asker's liveness. */
function opBlocks(op: OwnerOp, row: WatchRow | undefined): boolean | undefined {
  if (op.kind === "resolve-gate") return gateBlocks(op.gateId, row) && atHead(row, op.headSha);
  if (op.kind === "merge-at-head" || op.kind === "release-hold") return atHead(row, op.headSha);
  return CLEANUP_OPS.has(op.kind) ? false : undefined;
}

const askerLive = (item: OwnerItem, liveAgents: ReadonlySet<string> | undefined): boolean => {
  const { asker } = item;
  return asker !== undefined && liveAgents?.has(asker) === true;
};

function depositBlocks(item: OwnerItem, { row, liveAgents }: BlockingFacts): boolean {
  const byOp = item.op === undefined ? undefined : opBlocks(item.op, row);
  return byOp ?? askerLive(item, liveAgents);
}

function blocks(item: OwnerItem, facts: BlockingFacts): boolean {
  const source = item.sources[0]!;
  switch (source.system) {
    case "hitl":
      return gateBlocks(source.ref, facts.row);
    case "deposit":
      return depositBlocks(item, facts);
    case "agent-chat":
      return askerLive(item, facts.liveAgents);
    default:
      return false;
  }
}

/** An open round blocks whatever its lens; any other item must both be asked as blocking and pass its source's rule. */
export function sectionOf(item: OwnerItem, facts: BlockingFacts): InboxSection {
  const openRound = item.sources[0]!.system === "round";
  return openRound || (askedAsBlocking(item) && blocks(item, facts)) ? "blocking" : "planning";
}

const roundOf = (item: OwnerItem): string | undefined => {
  const source = item.sources[0]!;
  if (source.system !== "round") return undefined;
  return source.ref.includes("#") ? source.ref.slice(0, source.ref.indexOf("#")) : source.ref;
};

/** A round's questions as one row: the first question stands for it, and its per-question options stay on the round page. */
function roundRow<T extends OwnerItem>(roundId: string, questions: readonly T[]): T & { questionCount: number } {
  const [first] = questions as [T, ...T[]];
  const row: T = { ...first };
  delete row.options;
  delete row.recommended;
  const lens = questions.some((each) => each.lens === "blocking-merge") ? "blocking-merge" : first.lens;
  const keys = [...new Set(questions.flatMap((each) => each.keys))];
  return { ...row, id: `round:${roundId}`, lens, keys, questionCount: questions.length };
}

/** One inbox row per round, in the place of its first question; an item from any other source passes through. */
export function oneRowPerRound<T extends OwnerItem>(items: readonly T[]): (T | (T & { questionCount: number }))[] {
  const byRound = new Map<string, T[]>();
  for (const item of items) {
    const roundId = roundOf(item);
    if (roundId !== undefined) byRound.set(roundId, [...(byRound.get(roundId) ?? []), item]);
  }
  return items.flatMap((item) => {
    const roundId = roundOf(item);
    if (roundId === undefined) return [item];
    const questions = byRound.get(roundId)!;
    if (questions[0] !== item) return [];
    return [questions.length === 1 ? item : roundRow(roundId, questions)];
  });
}
