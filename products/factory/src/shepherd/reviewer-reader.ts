import { stat } from "node:fs/promises";
import os from "node:os";
import { claudeSourceFromPath, readSessionObservations, type NormalizedSessionObservation } from "@titan-design/session-read";
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

/** One message per assistant text part written in this conversation; user messages and copied history yield none. */
export function reviewerMessages(agentId: string, observation: NormalizedSessionObservation): ReviewerMessage[] {
  if (observation.kind !== "message" || observation.role !== "assistant" || observation.historyOrigin !== null) return [];
  const writtenAt = observation.timestamp === null ? Number.NaN : Date.parse(observation.timestamp);
  const sessionId = observation.conversation.nativeId;
  return observation.content.map((part) => ({ agentId, sessionId, writtenAt, text: part.text, locator: part.locator }));
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
      const found = reviewerMessages(agentId, observation);
      if (found.length === 0) {
        continued ||= final !== null && continuesPast(final, observation);
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

/** Reads every complete record; none when the file holds bytes past the last one, because a later record is still being written. */
async function readWholeTranscript(agentId: string, transcriptPath: string, namespace: string): Promise<readonly ReviewerMessage[]> {
  const turn = finishedTurnMessages(agentId);
  let consumedBytes = -1;
  const source = claudeSourceFromPath(transcriptPath, namespace);
  for await (const observation of readSessionObservations(source, {}, (done) => (consumedBytes = done.resumeBoundary.byteOffset))) {
    turn.add(observation);
  }
  return (await stat(transcriptPath)).size === consumedBytes ? turn.result() : [];
}

/** Reads the dispatched reviewer's own finished transcript; a read error propagates, and the caller treats it as nothing yet. */
export function transcriptReviewerReader(options: TranscriptReviewerReaderOptions): ReviewerReader {
  const namespace = options.namespace ?? os.hostname();
  return {
    async read(input) {
      const row = finishedTranscript(await options.roster(), input);
      return row ? readWholeTranscript(row.agentId, row.transcriptPath, namespace) : [];
    },
  };
}
