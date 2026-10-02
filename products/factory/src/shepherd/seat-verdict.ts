import { parseVerdictBlock } from "@titan-design/session-read";
import type { AwaitVerdictResult, ReviewTarget, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";

/** A seat's independent reviewer, as the seats name them; Shepherd's own reviewers are named `rv-*` and never match. */
export const SEAT_REVIEWER = /-review(-r[0-9]+)?$/;

interface AtHead {
  message: ReviewerMessage;
  verdict: "MERGE" | "FIX_FIRST";
}

/** The newest verdict block naming this PR at this head; on a tie in time the FIX_FIRST wins. */
export function newestAtHead(target: ReviewTarget, messages: readonly ReviewerMessage[]): AtHead | undefined {
  let newest: AtHead | undefined;
  for (const message of messages) {
    const block = parseVerdictBlock(message.text);
    if (!block.ok || !Number.isFinite(message.writtenAt)) continue;
    if (block.repo !== target.repo || block.pr !== target.pr || block.head !== target.head) continue;
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
