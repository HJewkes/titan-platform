import { stat } from "node:fs/promises";
import os from "node:os";
import { claudeSourceFromPath, readSessionObservations, type NormalizedSessionObservation } from "@titan-design/session-read";
import { isInvestigativeCall } from "./depth-floor.js";
import { DamagedTranscriptError } from "./external-review.js";
import type { Presence } from "./presence.js";
import type { AwaitVerdictInput, ReviewerMessage, ReviewerReader } from "./review.js";

/** The roster fields the reader needs; an `agent ls --json` row carries all of them. */
export interface TranscriptRow {
  agentId: string;
  sessionId: string;
  presence: Presence;
  transcriptPath: string | null;
  transcriptExists: boolean;
}

export interface TranscriptReviewerReaderOptions {
  roster: () => Promise<readonly TranscriptRow[]>;
  /** Names the machine in every locator; defaults to the hostname, as session-miner does. */
  namespace?: string;
}

/** Only `exited` is a finished session; a `detached` process may still be writing its turn. */
const FINISHED: Presence = "exited";

/** Where the last assistant text sits: the byte offset of its record and its index in that record's content. */
interface FinalText {
  line: number;
  part: number;
}

const writtenAt = (observation: NormalizedSessionObservation) => (observation.timestamp === null ? Number.NaN : Date.parse(observation.timestamp));

/** One message per assistant text part written in this conversation; user messages and copied history yield none. `synthetic` marks a record the client wrote. */
export function reviewerMessages(agentId: string, observation: NormalizedSessionObservation, synthetic?: ReviewerMessage["synthetic"]): ReviewerMessage[] {
  if (observation.kind !== "message" || observation.role !== "assistant" || observation.historyOrigin !== null) return [];
  const sessionId = observation.conversation.nativeId;
  return observation.content.map((part) => ({ agentId, sessionId, writtenAt: writtenAt(observation), text: part.text, locator: part.locator, ...(synthetic && { synthetic }) }));
}

/** Claude Code's model name on a record it wrote itself, such as an API error notice; a model's own output never carries it. */
const SYNTHETIC_MODEL = "<synthetic>";

/** The API error and quota reset of a record the client wrote, read from its metadata; undefined for a model's own record. */
function syntheticOf(observation: NormalizedSessionObservation): ReviewerMessage["synthetic"] {
  if (observation.kind !== "metadata") return undefined;
  const value = (name: string): unknown => observation.entries.find((entry) => entry.name === name)?.value;
  if (value("model") !== SYNTHETIC_MODEL) return undefined;
  const error = value("error");
  const reset = (value("quotaLimits") as { resetsAt?: unknown } | null | undefined)?.resetsAt;
  return { apiError: typeof error === "string" ? error : null, resetsAt: typeof reset === "number" && Number.isFinite(reset) ? reset * 1000 : null };
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

/** The text of a user message written in this conversation, or null for any other observation. */
function userText(observation: NormalizedSessionObservation): string | null {
  if (observation.kind !== "message" || observation.role !== "user" || observation.historyOrigin !== null) return null;
  return observation.content.map((part) => part.text).join("\n");
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
 * result, a user message or a thinking-only record after the last text means the turn was not finished. Each message
 * carries the count of investigative calls the session made up to it.
 */
export function finishedTurnMessages(agentId: string) {
  const messages: ReviewerMessage[] = [];
  let final: FinalText | null = null;
  let continued = false;
  let investigativeCalls = 0;
  // The decoder emits a record's metadata just before its message, so a mark applies to messages on the same line only.
  let client: { line: number; synthetic: ReviewerMessage["synthetic"] } | undefined;
  const stamped = (found: ReviewerMessage[]) => found.map((message) => ({ ...message, investigativeCalls }));
  return {
    add(observation: NormalizedSessionObservation): void {
      if (isInvestigativeCall(observation)) investigativeCalls += 1;
      const line = observation.evidence.line.byteOffset;
      const marked = syntheticOf(observation);
      if (marked) client = { line, synthetic: marked };
      // A sent message is kept but is never the final text, so a turn that ends on the call is still unfinished.
      const sent = stamped(sentMessages(agentId, observation));
      messages.push(...sent);
      const found = stamped(reviewerMessages(agentId, observation, client?.line === line ? client.synthetic : undefined));
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
function finishedTranscript(rows: readonly TranscriptRow[], input: AwaitVerdictInput): SeatRow | null {
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
  /** The first user message in a complete record: the brief the reviewer was started with. */
  brief: string | null;
  /** False when the file holds bytes past the last complete record. */
  whole: boolean;
}

async function scanTranscript(agentId: string, transcriptPath: string, namespace: string): Promise<Scan> {
  const turn = finishedTurnMessages(agentId);
  const sent: ReviewerMessage[] = [];
  const written: ReviewerMessage[] = [];
  let brief: string | null = null;
  let consumedBytes = -1;
  const source = claudeSourceFromPath(transcriptPath, namespace);
  for await (const observation of readSessionObservations(source, {}, (done) => (consumedBytes = done.resumeBoundary.byteOffset))) {
    turn.add(observation);
    const sentHere = sentMessages(agentId, observation);
    sent.push(...sentHere);
    written.push(...reviewerMessages(agentId, observation), ...sentHere);
    brief ??= userText(observation);
  }
  return { finished: turn.result(), sent, written, brief, whole: (await stat(transcriptPath)).size === consumedBytes };
}

/** Reads every complete record; none when the file holds bytes past the last one, because a later record is still being written. */
async function readWholeTranscript(agentId: string, transcriptPath: string, namespace: string): Promise<readonly ReviewerMessage[]> {
  const scan = await scanTranscript(agentId, transcriptPath, namespace);
  return scan.whole ? scan.finished : [];
}

/** Presences whose process may still append to the transcript, so a partial last record is a write in progress. */
const RUNNING: ReadonlySet<Presence> = new Set<Presence>(["live", "exiting"]);

/**
 * A process that died mid-turn never writes its final text, so its sent messages count on their own. A partial last
 * record is a write in progress only while the reviewer runs; once it has exited or detached, it is damage, and rejects with what the complete records said and the brief.
 */
async function readSeatTranscript(row: SeatRow, namespace: string): Promise<readonly ReviewerMessage[]> {
  const scan = await scanTranscript(row.agentId, row.transcriptPath, namespace);
  if (!scan.whole && !RUNNING.has(row.presence)) {
    throw new DamagedTranscriptError(`the ${row.presence} session ${row.sessionId} ends in a partial record`, scan.written, scan.brief);
  }
  return scan.whole && scan.finished.length > 0 ? scan.finished : scan.sent;
}

/** The transcript of this agent and session whatever its presence, or null when there is none yet. */
function seatTranscript(rows: readonly TranscriptRow[], input: AwaitVerdictInput): SeatRow | null {
  const row = rows.find((candidate) => candidate.agentId === input.reviewerAgentId && candidate.sessionId === input.reviewerSessionId);
  if (!row || !row.transcriptExists || row.transcriptPath === null) return null;
  return { ...row, transcriptPath: row.transcriptPath };
}

type SeatRow = TranscriptRow & { transcriptPath: string };

/**
 * What a seat read depends on: the session, the presence that decides whether a partial record is damage, and the file's
 * size and mtime, which move when a verdict is appended. Equal signatures read equal.
 */
async function seatSignature(row: SeatRow): Promise<string | null> {
  try {
    const { size, mtimeMs } = await stat(row.transcriptPath);
    return [row.agentId, row.sessionId, row.presence, size, mtimeMs].join("|");
  } catch {
    return null;
  }
}

interface SeatReader {
  read: (row: SeatRow) => Promise<readonly ReviewerMessage[]>;
  retain: (rows: readonly TranscriptRow[]) => void;
}

/** Reads each seat transcript once until its signature changes; a damaged read is cached as the same rejection, any other failure is retried. */
function cachedSeatReader(namespace: string): SeatReader {
  const cache = new Map<string, { signature: string; result: Promise<readonly ReviewerMessage[]> }>();
  const read = async (row: SeatRow) => {
    const signature = await seatSignature(row);
    if (signature === null) return readSeatTranscript(row, namespace);
    const hit = cache.get(row.transcriptPath);
    if (hit?.signature === signature) return hit.result;
    const result = readSeatTranscript(row, namespace);
    cache.set(row.transcriptPath, { signature, result });
    result.catch((error: unknown) => {
      if (!(error instanceof DamagedTranscriptError) && cache.get(row.transcriptPath)?.result === result) cache.delete(row.transcriptPath);
    });
    return result;
  };
  /** Drops the entries of transcripts the roster no longer lists, so a retired reviewer's messages are not held for the process's life. */
  const retain = (rows: readonly TranscriptRow[]): void => {
    const listed = new Set(rows.map((candidate) => candidate.transcriptPath));
    for (const key of cache.keys()) if (!listed.has(key)) cache.delete(key);
  };
  return { read, retain };
}

/** Reads the dispatched reviewer's own finished transcript; a read error propagates, and the caller treats it as nothing yet. */
export function transcriptReviewerReader(options: TranscriptReviewerReaderOptions): ReviewerReader {
  const namespace = options.namespace ?? os.hostname();
  const seats = cachedSeatReader(namespace);
  return {
    async read(input) {
      const rows = await options.roster();
      seats.retain(rows);
      const row = finishedTranscript(rows, input);
      return row ? readWholeTranscript(row.agentId, row.transcriptPath, namespace) : [];
    },
    async readSeat(input) {
      const rows = await options.roster();
      seats.retain(rows);
      const row = seatTranscript(rows, input);
      return row ? seats.read(row) : [];
    },
  };
}
