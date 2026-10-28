/**
 * Which inbox items block running work, as one rule per source (TP-4352). An item is blocking only when data it already
 * carries shows something live waits on the answer: a hitl gate its live run is pending on at a PR head, a deposit or
 * agent-chat question whose asker is live (or whose op names a live head), or an open round. Morning is frozen
 * (decision 530) and an active-work task waits on nobody, so neither is ever blocking. A source the console cannot read
 * a fact for stays non-blocking rather than guessing. Across items, a PR keeps one row, its newest ask, and a blocking
 * item past four days is marked aged so the page lists it apart, never hidden.
 */
import { LIVE_HISTORY_STATES, type AgentRosterSnapshot } from "@titan-design/chat-protocol/agents";
import type { OwnerItem, OwnerOp } from "@titan-design/owner-queue";
import { pinKey, roundAnswers } from "./round-gate-cover.js";
import type { ShepherdSource } from "./shepherd.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

export type InboxSection = "blocking" | "planning";

interface BlockingFacts {
  /** The live Shepherd row the item's gate or op joins, when it joins one. */
  row: WatchRow | undefined;
  /** Names of agents the broker sees live; undefined when the roster was not read, so no asker can be called live. */
  liveAgents: ReadonlySet<string> | undefined;
  now: number;
}

const DAY = 24 * 60 * 60_000;
/** A permission or endorse prompt a day old has timed out or been relayed, so its agent no longer waits on the tap. */
const CHAT_APPROVAL_STALE_MS = DAY;
/** Past this a blocking item is listed under "Older than 4 days": still blocking, never hidden. */
const AGED_AFTER_MS = 4 * DAY;

const ageOf = (item: OwnerItem, now: number): number => now - Date.parse(item.openedAt);

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

/** A personal deposit waits on the owner's own life, not on running work. */
function depositBlocks(item: OwnerItem, { row, liveAgents }: BlockingFacts): boolean {
  if (item.personal) return false;
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
      return askerLive(item, facts.liveAgents) && !(item.kind === "approve" && ageOf(item, facts.now) > CHAT_APPROVAL_STALE_MS);
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
  const first = questions[0]!;
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

const prRef = (repo: string, pr: number): string => `${repo.toLowerCase()}#${pr}`;
const PR_KEY = /^pr:(.+#\d+)(@[0-9a-f]+)?$/i;

/** The one PR an item asks about: its live row's, its op's, or its `pr:` key's. A round asks about many, so it pins none. */
export function pinOf(item: OwnerItem, row: WatchRow | undefined): string | undefined {
  if (item.sources[0]!.system === "round") return undefined;
  if (row?.pr != null) return prRef(row.repo, row.pr);
  const { op } = item;
  if (op !== undefined && "repo" in op) return prRef(op.repo, op.pr);
  const key = item.keys.map((each) => PR_KEY.exec(each)).find((match) => match !== null);
  return key == null ? undefined : key[1]!.toLowerCase();
}

interface Sectioned extends OwnerItem {
  section: InboxSection;
}

export interface Placed<T extends Sectioned> {
  item: T;
  pin: string | undefined;
  /** A hitl gate's `pr:<repo>#<n>@<head>` at its live row's head, the key a merge-bound round question pins. */
  head?: string;
}

/**
 * The head a hitl gate could fold at, in `prKey`'s form: only the live row's pending gate, and only on a step a round's
 * answer posts to (`round-gate-cover.ts`). Any other gate on the run, an sh-sent-back one included, keeps its own row.
 */
export function gateHeadOf(item: OwnerItem, row: WatchRow | undefined): string | undefined {
  const source = item.sources[0]!;
  if (source.system !== "hitl" || row?.pr == null || row.headSha == null) return undefined;
  const gate = row.pendingGate;
  if (!roundAnswers(gate) || gate.gateId.toLowerCase() !== source.ref.toLowerCase()) return undefined;
  return pinKey(row.repo, row.pr, row.headSha);
}

function coveringRounds(placed: readonly Placed<Sectioned>[]): Map<string, string> {
  const rounds = new Map<string, string>();
  for (const { item } of placed) {
    const roundId = roundOf(item);
    if (roundId !== undefined) for (const key of item.keys) if (key.startsWith("pr:")) rounds.set(key.toLowerCase(), roundId);
  }
  return rounds;
}

/**
 * TP-4356: an open round whose merge-bound question pins a PR head answers that head's approve-merge or visual accept
 * gate, so the gate folds into the round's row and the row lists it in `foldedGates`. A gate at any other head is not
 * what the round reviewed, and any other step is not the round's to settle: each keeps its own row.
 */
export function foldCoveredGates<T extends Sectioned>(placed: readonly Placed<T>[]): Placed<T & { foldedGates?: string[] }>[] {
  const covering = coveringRounds(placed);
  const folded = new Map<string, string[]>();
  const kept = placed.filter(({ item, head }) => {
    const roundId = head === undefined ? undefined : covering.get(head);
    if (roundId !== undefined) folded.set(roundId, [...(folded.get(roundId) ?? []), item.id]);
    return roundId === undefined;
  });
  return kept.map((each) => {
    const gates = folded.get(roundOf(each.item) ?? "");
    return gates === undefined ? each : { ...each, item: { ...each.item, foldedGates: gates } };
  });
}

const SENT_BACK = /\/sh-sent-back(:\d+)?$/;
const isSentBack = ({ sources: [source] }: OwnerItem): boolean => source!.system === "hitl" && SENT_BACK.test(source!.ref);
const isOwnerOp = (item: OwnerItem): boolean => item.sources[0]!.system === "deposit" && item.op !== undefined;
const newer = (a: OwnerItem, b: OwnerItem): boolean => a.openedAt > b.openedAt || (a.openedAt === b.openedAt && a.id > b.id);

/**
 * R2: an sh-sent-back gate clears on the implementer's next head, so it blocks only beside a blocking deposit op.
 * R1: a PR keeps one blocking row, its newest ask, since a later ask about the same PR restates or replaces the earlier
 * one. Both read only items still blocking, so a Planning item never demotes a live blocker, and R2 runs first so a
 * gate it demotes never takes the PR's one row with it.
 */
function keeperOf(blocking: readonly Sectioned[]): Sectioned | undefined {
  const asksOwner = blocking.some(isOwnerOp);
  const eligible = blocking.filter((item) => asksOwner || !isSentBack(item));
  return eligible.reduce<Sectioned | undefined>((best, item) => (best === undefined || newer(item, best) ? item : best), undefined);
}

export function onePerPr<T extends Sectioned>(placed: readonly Placed<T>[]): T[] {
  const byPr = new Map<string, T[]>();
  for (const { item, pin } of placed) {
    if (pin === undefined || item.section !== "blocking") continue;
    byPr.set(pin, [...(byPr.get(pin) ?? []), item]);
  }
  const keepers = new Set([...byPr.values()].map(keeperOf));
  return placed.map(({ item, pin }) => (pin !== undefined && item.section === "blocking" && !keepers.has(item) ? { ...item, section: "planning" } : item));
}

/** R5: a blocking item past four days is marked aged, so the page lists it in its own subsection. */
export function markAged<T extends Sectioned>(items: readonly T[], now: number): (T & { aged?: true })[] {
  return items.map((item) => (item.section === "blocking" && ageOf(item, now) > AGED_AFTER_MS ? { ...item, aged: true } : item));
}
