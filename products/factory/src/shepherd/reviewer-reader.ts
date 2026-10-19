import { stat } from "node:fs/promises";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { inSessionSourceOrder, assistantTextFinality, claudeSourceFromPath, readSessionObservations, type NormalizedSessionObservation, type SessionSourceDescriptor } from "@titan-design/session-read";
import { DamagedTranscriptError, type SeatReader } from "./external-review.js";
import type { Presence } from "./presence.js";
import { isInvestigativeCall, type AwaitVerdictInput, type ReviewerAgent, type ReviewerMessage } from "@titan-design/review-panel";

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
  /** Explicit source mapping only; absence retains legacy Claude path reading. No discovery or provider inference. */
  sourceFor?: (row: Readonly<TranscriptRow>) => SessionSourceDescriptor;
}

/** Resolve one caller-declared source, copied before awaits; mismatch rejects without fallback. */
function declaredSource(row: SeatRow, namespace: string, sourceFor: TranscriptReviewerReaderOptions["sourceFor"]): SessionSourceDescriptor | undefined {
  if (sourceFor === undefined) return undefined;
  const source = structuredClone(sourceFor(Object.freeze({ ...row })));
  if (source.path !== row.transcriptPath || source.namespace !== namespace ||
      source.conversation.namespace !== namespace || source.conversation.nativeId !== row.sessionId ||
      source.conversation.harness !== source.harness) {
    throw new TypeError("reviewer source descriptor does not match the roster session/path/namespace");
  }
  return source;
}

/** Only `exited` is a finished session; a `detached` process may still be writing its turn. */
const FINISHED: Presence = "exited";

const writtenAt = (observation: NormalizedSessionObservation) => (observation.timestamp === null ? Number.NaN : Date.parse(observation.timestamp));

/** One message per assistant text part written in this conversation; user messages and copied history yield none. `synthetic` marks a record the client wrote. */
export function reviewerMessages(agentId: string, observation: NormalizedSessionObservation, synthetic?: ReviewerMessage["synthetic"]): ReviewerMessage[] {
  if (observation.kind !== "message" || observation.role !== "assistant" || observation.historyOrigin !== null) return [];
  const sessionId = observation.conversation.nativeId;
  return observation.content.map((part) => ({ agentId, sessionId, writtenAt: writtenAt(observation), text: part.text, locator: part.locator, ...(synthetic && { synthetic }) }));
}

/** Claude Code's model name on a record it wrote itself, such as an API error notice; a model's own output never carries it. */
const SYNTHETIC_MODEL = "<synthetic>";

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The API error and quota reset of a record the client wrote, read from its metadata; undefined for a model's own record. */
function syntheticOf(observation: NormalizedSessionObservation): ReviewerMessage["synthetic"] {
  if (observation.kind !== "metadata") return undefined;
  const value = (name: string): unknown => observation.entries.find((entry) => entry.name === name)?.value;
  if (value("model") !== SYNTHETIC_MODEL) return undefined;
  const error = value("error");
  const reset = fieldOf(value("quotaLimits"), "resetsAt");
  return { apiError: typeof error === "string" ? error : null, resetsAt: typeof reset === "number" && Number.isFinite(reset) ? reset * 1000 : null };
}

/** A seat reviewer sends its verdict as a chat_send call's `text` input, never as an assistant text part. */
export function sentMessages(agentId: string, observation: NormalizedSessionObservation): ReviewerMessage[] {
  if (observation.kind !== "tool_call" || !observation.name.endsWith("chat_send") || observation.historyOrigin !== null) return [];
  const text = fieldOf(observation.input, "text");
  const inputLocator = observation.inputLocator;
  if (typeof text !== "string" || inputLocator === null) return [];
  const locator = { ...inputLocator, selector: { ...inputLocator.selector, path: [...inputLocator.selector.path, "text"] } };
  return [{ agentId, sessionId: observation.conversation.nativeId, writtenAt: writtenAt(observation), text, locator }];
}

/** The text of a user message written in this conversation, or null for any other observation. */
function userText(observation: NormalizedSessionObservation): string | null {
  if (observation.kind !== "message" || observation.role !== "user" || observation.historyOrigin !== null) return null;
  return observation.content.map((part) => part.text).join("\n");
}

/**
 * The reviewer's messages in file order, or none unless the conversation ends with assistant text: a tool call, a tool
 * result, a user message or a thinking-only record after the last text means the turn was not finished. Each message
 * carries the count of investigative calls the session made up to it.
 */
export function finishedTurnMessages(agentId: string) {
  const messages: ReviewerMessage[] = [];
  const finality = assistantTextFinality();
  // A valid sent verdict continues the product conversation even before text on the same native record.
  let sentSinceText = false;
  let investigativeCalls = 0;
  // The decoder emits a record's metadata just before its message, so a mark applies to messages on the same line only.
  let client: { line: number; synthetic: ReviewerMessage["synthetic"] } | undefined;
  const stamped = (found: ReviewerMessage[]) => found.map((message) => ({ ...message, investigativeCalls }));
  return {
    add(observation: NormalizedSessionObservation): void {
      finality.add(observation);
      if (isInvestigativeCall(observation)) investigativeCalls += 1;
      const line = observation.evidence.line.byteOffset;
      const marked = syntheticOf(observation);
      if (marked) client = { line, synthetic: marked };
      // A sent message is kept but is never the final text, so a turn that ends on the call is still unfinished.
      const sent = stamped(sentMessages(agentId, observation));
      messages.push(...sent);
      const found = stamped(reviewerMessages(agentId, observation, client?.line === line ? client.synthetic : undefined));
      if (found.length > 0) sentSinceText = false;
      if (sent.length > 0) sentSinceText = true;
      messages.push(...found);
    },
    result: (): readonly ReviewerMessage[] => (finality.hasFinalText() && !sentSinceText ? messages : []),
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

async function scanTranscript(agentId: string, transcriptPath: string, namespace: string, declared?: SessionSourceDescriptor): Promise<Scan> {
  const turn = finishedTurnMessages(agentId);
  const sent: ReviewerMessage[] = [];
  const written: ReviewerMessage[] = [];
  let brief: string | null = null;
  let consumedBytes = -1;
  const source = declared ?? claudeSourceFromPath(transcriptPath, namespace);
  const observations = readSessionObservations(source, {}, (done) => (consumedBytes = done.resumeBoundary.byteOffset));
  for await (const observation of inSessionSourceOrder(source, observations)) {
    turn.add(observation);
    const sentHere = sentMessages(agentId, observation);
    sent.push(...sentHere);
    written.push(...reviewerMessages(agentId, observation), ...sentHere);
    brief ??= userText(observation);
  }
  return { finished: turn.result(), sent, written, brief, whole: (await stat(transcriptPath)).size === consumedBytes };
}

/** Reads every complete record; none when the file holds bytes past the last one, because a later record is still being written. */
async function readWholeTranscript(agentId: string, transcriptPath: string, namespace: string, declared?: SessionSourceDescriptor): Promise<readonly ReviewerMessage[]> {
  const scan = await scanTranscript(agentId, transcriptPath, namespace, declared);
  return scan.whole ? scan.finished : [];
}

/** Presences whose process may still append to the transcript, so a partial last record is a write in progress. */
const RUNNING: ReadonlySet<Presence> = new Set<Presence>(["live", "exiting"]);

/**
 * A process that died mid-turn never writes its final text, so its sent messages count on their own. A partial last
 * record is a write in progress only while the reviewer runs; once it has exited or detached, it is damage, and rejects with what the complete records said and the brief.
 */
async function readSeatTranscript(row: SeatRow, namespace: string, declared?: SessionSourceDescriptor): Promise<readonly ReviewerMessage[]> {
  const scan = await scanTranscript(row.agentId, row.transcriptPath, namespace, declared);
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

interface SeatCache {
  read: (row: SeatRow) => Promise<readonly ReviewerMessage[]>;
  retain: (rows: readonly TranscriptRow[]) => void;
}

/** Reads each seat transcript once until its signature changes; a damaged read is cached as the same rejection, any other failure is retried. */
function cachedSeatReader(namespace: string, sourceFor: TranscriptReviewerReaderOptions["sourceFor"]): SeatCache {
  const cache = new Map<string, { signature: string; source: SessionSourceDescriptor | undefined; result: Promise<readonly ReviewerMessage[]> }>();
  const read = async (row: SeatRow) => {
    const source = declaredSource(row, namespace, sourceFor);
    const signature = await seatSignature(row);
    if (signature === null) return readSeatTranscript(row, namespace, source);
    const hit = cache.get(row.transcriptPath);
    if (hit?.signature === signature && isDeepStrictEqual(hit.source, source)) return hit.result;
    const result = readSeatTranscript(row, namespace, source);
    // Locator sources are public mutable values; the cache identity must never alias them.
    cache.set(row.transcriptPath, { signature, source: source === undefined ? undefined : structuredClone(source), result });
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

const isTranscriptRow = (row: unknown): row is TranscriptRow => {
  const path = fieldOf(row, "transcriptPath");
  return (
    typeof fieldOf(row, "agentId") === "string" &&
    typeof fieldOf(row, "sessionId") === "string" &&
    typeof fieldOf(row, "presence") === "string" &&
    typeof fieldOf(row, "transcriptExists") === "boolean" &&
    (typeof path === "string" || path === null)
  );
};

/**
 * A caller's roster is trusted only when the input's own row, the first match as `seatTranscript` finds it, carries transcript
 * fields; anything else reads as a fresh roster would, never as "no transcript".
 */
function heldTranscriptRows(held: readonly ReviewerAgent[] | undefined, input: AwaitVerdictInput): readonly TranscriptRow[] | null {
  const own = held?.find((row) => row.agentId === input.reviewerAgentId && row.sessionId === input.reviewerSessionId);
  return held && isTranscriptRow(own) ? held.flatMap((row) => (isTranscriptRow(row) ? [row] : [])) : null;
}

/** Reads the dispatched reviewer's own finished transcript; a read error propagates, and the caller treats it as nothing yet. */
export function transcriptReviewerReader(options: TranscriptReviewerReaderOptions): SeatReader {
  const namespace = options.namespace ?? os.hostname();
  const seats = cachedSeatReader(namespace, options.sourceFor);
  return {
    async read(input) {
      const rows = await options.roster();
      seats.retain(rows);
      const row = finishedTranscript(rows, input);
      return row ? readWholeTranscript(row.agentId, row.transcriptPath, namespace, declaredSource(row, namespace, options.sourceFor)) : [];
    },
    async readSeat(input, held) {
      const rows = heldTranscriptRows(held, input) ?? (await options.roster());
      seats.retain(rows);
      const row = seatTranscript(rows, input);
      return row ? seats.read(row) : [];
    },
  };
}
