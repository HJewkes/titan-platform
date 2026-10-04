import { stat } from "node:fs/promises";
import os from "node:os";
import { claudeSourceFromPath, readSessionObservations, type NormalizedSessionObservation } from "@titan-design/session-read";
import { DamagedTranscriptError } from "./external-review.js";
import type { AwaitVerdictInput, ReviewerMessage, ReviewerReader } from "./review.js";

/** The roster fields the reader needs; an `agent ls --json` row carries all of them. */
export interface TranscriptRow {
  agentId: string;
  sessionId: string;
  presence: string;
  transcriptPath: string | null;
  transcriptExists: boolean;
}

export interface TranscriptReviewerReaderOptions {
  roster: () => Promise<readonly TranscriptRow[]>;
  /** Names the machine in every locator; defaults to the hostname, as session-miner does. */
  namespace?: string;
}

/** Only `exited` is a finished session; a `detached` process may still be writing its turn. */
const FINISHED = "exited";

/** Where the last assistant text sits: the byte offset of its record and its index in that record's content. */
interface FinalText {
  line: number;
  part: number;
}

const writtenAt = (observation: NormalizedSessionObservation) => (observation.timestamp === null ? Number.NaN : Date.parse(observation.timestamp));

/** One message per assistant text part written in this conversation; user messages and copied history yield none. */
export function reviewerMessages(agentId: string, observation: NormalizedSessionObservation): ReviewerMessage[] {
  if (observation.kind !== "message" || observation.role !== "assistant" || observation.historyOrigin !== null) return [];
  const sessionId = observation.conversation.nativeId;
  return observation.content.map((part) => ({ agentId, sessionId, writtenAt: writtenAt(observation), text: part.text, locator: part.locator }));
}

/** A seat reviewer sends its verdict as a chat_send call's `text` input, never as an assistant text part. */
export function sentMessages(agentId: string, observation: NormalizedSessionObservation): ReviewerMessage[] {
  if (observation.kind !== "tool_call" || !observation.name.endsWith("chat_send") || observation.historyOrigin !== null) return [];
  const text = (observation.input as { text?: unknown } | null)?.text;
  const inputLocator = observation.inputLocator;
  if (typeof text !== "string" || inputLocator === null) return [];
  const locator = { ...inputLocator, selector: { ...inputLocator.selector, path: [...inputLocator.selector.path, "text"] } };
  return [{ agentId, sessionId: observation.conversation.nativeId, writtenAt: writtenAt(observation), text, locator }];
}

/** The index under `message.content` a path points into, or -1 when it points elsewhere in the record. */
function contentIndex(path: readonly (string | number)[]): number {
  return path[0] === "message" && path[1] === "content" && typeof path[2] === "number" ? path[2] : -1;
}

/** Records that are not part of the conversation: titles, hook summaries and the like. An unknown kind is not one of them. */
function isBookkeeping(observation: NormalizedSessionObservation): boolean {
  if (observation.kind === "metadata") return !observation.entries.some((entry) => entry.name === "model");
  if (observation.kind !== "unknown") return false;
  return !observation.nativeKind.startsWith("claude.content.") && !observation.nativeKind.startsWith("claude.message.");
}

/** True when the observation shows the conversation went on after the last assistant text. */
function continuesPast(final: FinalText, observation: NormalizedSessionObservation): boolean {
  const { line, subrecord } = observation.evidence;
  if (line.byteOffset === final.line) return contentIndex(subrecord.path) > final.part;
  return !isBookkeeping(observation);
}

/**
 * The reviewer's messages in file order, or none unless the conversation ends with assistant text: a tool call, a tool
 * result, a user message or a thinking-only record after the last text means the turn was not finished.
 */
export function finishedTurnMessages(agentId: string) {
  const messages: ReviewerMessage[] = [];
  let final: FinalText | null = null;
  let continued = false;
  return {
    add(observation: NormalizedSessionObservation): void {
      // A sent message is kept but is never the final text, so a turn that ends on the call is still unfinished.
      const sent = sentMessages(agentId, observation);
      messages.push(...sent);
      const found = reviewerMessages(agentId, observation);
      if (found.length === 0) {
        continued ||= sent.length > 0 || (final !== null && continuesPast(final, observation));
        return;
      }
      messages.push(...found);
      final = { line: observation.evidence.line.byteOffset, part: contentIndex(found.at(-1)!.locator.selector.path) };
      continued = false;
    },
    result: (): readonly ReviewerMessage[] => (continued ? [] : messages),
  };
}

/** The finished transcript of the dispatched agent and session, or null while there is nothing safe to read. */
function finishedTranscript(rows: readonly TranscriptRow[], input: AwaitVerdictInput): (TranscriptRow & { transcriptPath: string }) | null {
  const row = rows.find((candidate) => candidate.agentId === input.reviewerAgentId);
  if (!row || row.presence !== FINISHED || row.sessionId !== input.reviewerSessionId) return null;
  if (!row.transcriptExists || row.transcriptPath === null) return null;
  return { ...row, transcriptPath: row.transcriptPath };
}

interface Scan {
  /** The finished turn's messages, or none when the turn did not end on text. */
  finished: readonly ReviewerMessage[];
  /** Every chat_send message in a complete record, finished turn or not. */
  sent: readonly ReviewerMessage[];
  /** Every assistant text and chat_send message in a complete record. */
  written: readonly ReviewerMessage[];
  /** False when the file holds bytes past the last complete record. */
  whole: boolean;
}

async function scanTranscript(agentId: string, transcriptPath: string, namespace: string): Promise<Scan> {
  const turn = finishedTurnMessages(agentId);
  const sent: ReviewerMessage[] = [];
  const written: ReviewerMessage[] = [];
  let consumedBytes = -1;
  const source = claudeSourceFromPath(transcriptPath, namespace);
  for await (const observation of readSessionObservations(source, {}, (done) => (consumedBytes = done.resumeBoundary.byteOffset))) {
    turn.add(observation);
    const sentHere = sentMessages(agentId, observation);
    sent.push(...sentHere);
    written.push(...reviewerMessages(agentId, observation), ...sentHere);
  }
  return { finished: turn.result(), sent, written, whole: (await stat(transcriptPath)).size === consumedBytes };
}

/** Reads every complete record; none when the file holds bytes past the last one, because a later record is still being written. */
async function readWholeTranscript(agentId: string, transcriptPath: string, namespace: string): Promise<readonly ReviewerMessage[]> {
  const scan = await scanTranscript(agentId, transcriptPath, namespace);
  return scan.whole ? scan.finished : [];
}

/** Presences whose process may still append to the transcript, so a partial last record is a write in progress. */
const RUNNING: ReadonlySet<string> = new Set(["live", "exiting"]);

/**
 * A process that died mid-turn never writes its final text, so its sent messages count on their own. A partial last
 * record is a write in progress only while the reviewer runs; once it has exited or detached, it is damage, and rejects with what the complete records said.
 */
async function readSeatTranscript(row: TranscriptRow & { transcriptPath: string }, namespace: string): Promise<readonly ReviewerMessage[]> {
  const scan = await scanTranscript(row.agentId, row.transcriptPath, namespace);
  if (!scan.whole && !RUNNING.has(row.presence)) {
    throw new DamagedTranscriptError(`the ${row.presence} session ${row.sessionId} ends in a partial record`, scan.written);
  }
  return scan.whole && scan.finished.length > 0 ? scan.finished : scan.sent;
}

/** The transcript of this agent and session whatever its presence, or null when there is none yet. */
function seatTranscript(rows: readonly TranscriptRow[], input: AwaitVerdictInput): (TranscriptRow & { transcriptPath: string }) | null {
  const row = rows.find((candidate) => candidate.agentId === input.reviewerAgentId && candidate.sessionId === input.reviewerSessionId);
  if (!row || !row.transcriptExists || row.transcriptPath === null) return null;
  return { ...row, transcriptPath: row.transcriptPath };
}

/** Reads the dispatched reviewer's own finished transcript; a read error propagates, and the caller treats it as nothing yet. */
export function transcriptReviewerReader(options: TranscriptReviewerReaderOptions): ReviewerReader {
  const namespace = options.namespace ?? os.hostname();
  return {
    async read(input) {
      const row = finishedTranscript(await options.roster(), input);
      return row ? readWholeTranscript(row.agentId, row.transcriptPath, namespace) : [];
    },
    async readSeat(input) {
      const row = seatTranscript(await options.roster(), input);
      return row ? readSeatTranscript(row, namespace) : [];
    },
  };
}
