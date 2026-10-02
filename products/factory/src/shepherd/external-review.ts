import { parseVerdictBlock } from "@titan-design/session-read";
import { deadline } from "../workflows/deadline.js";
import { bounded } from "./await-verdict.js";
import type { AwaitVerdictResult, AwaitVerdictTiming, ReviewTarget, ReviewWiring, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";
import type { Registration } from "./store.js";

/** The reviewer a hold waits on, from `hold --reviewer` alone; a name in the hold's reason text is never read as one. */
export function externalReviewer(registration: Registration | undefined): string | undefined {
  if (!registration?.held) return undefined;
  return registration.holdReviewer ?? undefined;
}

export interface ExternalVerdictInput {
  repo: string;
  pr: number;
  head: string;
  external: string;
}

export function isExternalVerdictInput(raw: unknown): raw is ExternalVerdictInput {
  return typeof raw === "object" && raw !== null && typeof (raw as { external?: unknown }).external === "string";
}

/** The newest message of the reviewer's latest session whose verdict block names this PR at this head. */
export function acceptExternalVerdict(input: ExternalVerdictInput, row: ReviewerAgent, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const own = messages.filter((message) => message.agentId === row.agentId && message.sessionId === row.sessionId);
  for (const message of [...own].sort((a, b) => b.writtenAt - a.writtenAt)) {
    const block = parseVerdictBlock(message.text);
    if (!block.ok || block.repo !== input.repo || block.pr !== input.pr || block.head !== input.head) continue;
    const accepted = { kind: "verdict" as const, head: block.head, locator: message.locator, reviewer: { agentId: row.agentId, sessionId: row.sessionId } };
    return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE" } : { ...accepted, verdict: "FIX_FIRST", text: message.text };
  }
  return { kind: "none" };
}

/** A name can span sessions; the last row the roster lists with a session holds it. */
export function latestSession(name: string, roster: readonly ReviewerAgent[]): ReviewerAgent | undefined {
  return roster.filter((agent) => agent.name === name && agent.sessionId !== "").at(-1);
}

/** Polls the hold's reviewer for a verdict at this head; Shepherd starts nobody, and the deadline ends the wait with `none`. */
export async function awaitExternalVerdict(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, input: ExternalVerdictInput, timing: AwaitVerdictTiming, signal: AbortSignal): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const row = latestSession(input.external, await roster().catch(() => []));
    if (row) {
      const read = { repo: input.repo, pr: input.pr, head: input.head, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
      const result = acceptExternalVerdict(input, row, await reader.read(read).catch(() => []));
      if (result.kind === "verdict") return result;
    }
    if (clock.expired()) return { kind: "none" };
    await clock.sleep(timing.pollMs, signal);
  }
}

/** A seat's independent reviewer, as the seats name them; Shepherd's own reviewers are named `rv-*` and never match. */
export const SEAT_REVIEWER = /-review(-r[0-9]+)?$/;

interface AtHead {
  message: ReviewerMessage;
  verdict: "MERGE" | "FIX_FIRST";
}

/** The newest verdict block naming this PR at this head; GitHub repo names ignore case, and on a tie in time the FIX_FIRST wins. */
export function newestAtHead(target: ReviewTarget, messages: readonly ReviewerMessage[]): AtHead | undefined {
  let newest: AtHead | undefined;
  for (const message of messages) {
    const block = parseVerdictBlock(message.text);
    if (!block.ok || !Number.isFinite(message.writtenAt)) continue;
    if (block.repo.toLowerCase() !== target.repo.toLowerCase() || block.pr !== target.pr || block.head !== target.head) continue;
    const later = !newest || message.writtenAt > newest.message.writtenAt || (message.writtenAt === newest.message.writtenAt && block.verdict === "FIX_FIRST");
    if (later) newest = { message, verdict: block.verdict };
  }
  return newest;
}

/** Every session the roster lists under one name; a message the reader attributes to any other session is dropped. */
async function readReviewer(reader: ReviewerReader, target: ReviewTarget, rows: readonly ReviewerAgent[]): Promise<ReviewerMessage[]> {
  const read = (row: ReviewerAgent) => reader.read({ ...target, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 }).catch(() => []);
  const owned = (message: ReviewerMessage) => rows.some((row) => row.agentId === message.agentId && row.sessionId === message.sessionId);
  return (await Promise.all(rows.map(read))).flat().filter(owned);
}

/** The first seat reviewer whose newest verdict at this head is FIX_FIRST; an unreadable roster or transcript reads as none. */
export async function seatFixFirst(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, target: ReviewTarget): Promise<AwaitVerdictResult> {
  const rows = (await roster().catch(() => [])).filter((row) => SEAT_REVIEWER.test(row.name) && row.sessionId !== "");
  for (const name of new Set(rows.map((row) => row.name))) {
    const newest = newestAtHead(target, await readReviewer(reader, target, rows.filter((row) => row.name === name)));
    if (newest?.verdict !== "FIX_FIRST") continue;
    const { message } = newest;
    const text = `Seat reviewer ${name} said FIX_FIRST at this head.\n\n${message.text}`;
    return { kind: "verdict", verdict: "FIX_FIRST", head: target.head, locator: message.locator, reviewer: { agentId: message.agentId, sessionId: message.sessionId }, text };
  }
  return { kind: "none" };
}

/** A MERGE stands only while no seat reviewer's newest verdict at the same head is FIX_FIRST. */
export async function unlessSeatFixFirst(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, target: ReviewTarget, result: AwaitVerdictResult): Promise<AwaitVerdictResult> {
  if (result.kind !== "verdict" || result.verdict !== "MERGE") return result;
  const blocked = await seatFixFirst(roster, reader, target);
  return blocked.kind === "verdict" ? blocked : result;
}

type VerdictStep = (raw: unknown, signal: AbortSignal) => Promise<AwaitVerdictResult>;

/** Inside the step, so the replay reads the recorded outcome; with no dispatch wired there is no roster to read seat reviewers from. */
export function seatVetoed(wiring: ReviewWiring | undefined, body: VerdictStep): VerdictStep {
  return async (raw, signal) => {
    const result = await body(raw, signal);
    const dispatch = wiring?.dispatch;
    if (!dispatch) return result;
    const { repo, pr, head } = raw as ReviewTarget;
    return bounded(await unlessSeatFixFirst(() => dispatch.roster(), wiring.reader, { repo, pr, head }, result));
  };
}
