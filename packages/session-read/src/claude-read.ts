import { createHash } from "node:crypto";
import { prefixHash, readJsonLines, readLocatorBytes } from "@titan-design/locator";
import { ClaudeTranscriptDecoder } from "./claude-decoder.js";
import { assertClaudeSessionSource, claudeRecordBelongsToSource, CLAUDE_TRANSCRIPT_FORMAT } from "./claude-source.js";
import type {
  DecodeRequest,
  LocatedSourceLine,
  NormalizedSessionObservation,
  ResumeBoundary,
  SessionSourceDescriptor,
  SourceTextLocator,
} from "./normalized.js";
import { normalizedSearchText, SPAN_TEXT_CAP, stringLeaves } from "./text.js";
import type { ReadSessionObservationOptions, SessionObservationReadResult } from "./session-observations.js";

export interface ReadClaudeTextOptions {
  /** Fresh lookup results let callers resolve a moved source by stable source ID. */
  sources?: readonly SessionSourceDescriptor[];
}

/** Prefix-replay reader with bounded observation buffering and rewrite detection. */
export async function* readClaudeObservations(
  source: SessionSourceDescriptor,
  options: ReadSessionObservationOptions = {},
  onDone?: (result: SessionObservationReadResult) => void,
): AsyncGenerator<NormalizedSessionObservation> {
  assertClaudeSessionSource(source);
  const resume = await resolveResume(source.path, options.from);
  const queue = new ObservationQueue();
  const request: DecodeRequest<never> = {
    source,
    lines: locatedLines(source, queue, options.untilByteOffset),
    resume: { strategy: "replay-prefix", readFromByteOffset: 0, emitFrom: resume.emitFrom, checkpoint: null },
  };
  const decoding = new ClaudeTranscriptDecoder().decode(request, (observation) => queue.push(observation));
  decoding.then(() => queue.finish(), (error: unknown) => queue.fail(error));
  try {
    for await (const observation of queue) yield observation;
    const decoded = await decoding;
    onDone?.({ startByteOffset: resume.emitFrom.byteOffset, resumeBoundary: decoded.resumeBoundary, restartedFromZero: resume.restarted });
  } finally {
    queue.cancel();
    await decoding.catch(() => undefined);
  }
}

/** Read one selected semantic field from a Claude transcript locator. */
export async function readClaudeText(locator: SourceTextLocator, options: ReadClaudeTextOptions = {}): Promise<string | null> {
  try {
    if (locator.source.format !== CLAUDE_TRANSCRIPT_FORMAT || locator.source.harness !== "claude-code") return null;
    const source = resolveSource(locator, options.sources);
    if (!source) return null;
    assertClaudeSessionSource(source);
    const bytes = await readLocatorBytes(source.path, [0, locator.evidence.line.byteOffset, locator.evidence.line.byteLength]);
    if (hashBytes(bytes) !== locator.evidence.line.contentHash) return null;
    const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const record = JSON.parse(line) as unknown;
    if (typeof record !== "object" || record === null || Array.isArray(record) || !claudeRecordBelongsToSource(source, record as Record<string, unknown>)) return null;
    const selected = valueAt(record, locator.selector.path);
    return selectedText(selected, locator.selector.textIndex);
  } catch {
    return null;
  }
}

async function* locatedLines(
  source: SessionSourceDescriptor,
  queue: ObservationQueue,
  until?: number,
): AsyncGenerator<LocatedSourceLine> {
  let lineNumber = 0;
  for await (const line of readJsonLines(source.path, 0, { strictUtf8: true })) {
    if (!(await queue.waitForCapacity())) return;
    lineNumber += 1;
    yield {
      raw: line.text,
      evidence: {
        sourceId: source.sourceId,
        byteOffset: line.byteOffset,
        byteLength: line.byteLength,
        contentHash: hashLine(line.text),
        lineNumber,
        nativeOrdinal: null,
      },
    };
    if (until !== undefined && line.byteOffset + line.byteLength + 1 >= until) break;
  }
}

async function resolveResume(filePath: string, from?: ResumeBoundary): Promise<{ emitFrom: ResumeBoundary; restarted: boolean }> {
  const zero = { byteOffset: 0, prefixHash: await prefixHash(filePath, 0) };
  if (!from || from.byteOffset === 0) return { emitFrom: zero, restarted: false };
  const current = await prefixHash(filePath, from.byteOffset);
  return current === from.prefixHash ? { emitFrom: from, restarted: false } : { emitFrom: zero, restarted: true };
}

function resolveSource(locator: SourceTextLocator, sources?: readonly SessionSourceDescriptor[]): SessionSourceDescriptor | null {
  if (locator.evidence.line.sourceId !== locator.source.sourceId) return null;
  if (!sources) return locator.source;
  const matches = sources.filter((source) => source.sourceId === locator.source.sourceId && sameIdentity(source, locator.source));
  return matches.length === 1 ? matches[0]! : null;
}

function sameIdentity(left: SessionSourceDescriptor, right: SessionSourceDescriptor): boolean {
  return (
    left.harness === right.harness &&
    left.format === right.format &&
    left.namespace === right.namespace &&
    left.conversation.harness === right.conversation.harness &&
    left.conversation.namespace === right.conversation.namespace &&
    left.conversation.nativeId === right.conversation.nativeId &&
    left.provenance.kind === "claude-code-transcript" &&
    right.provenance.kind === "claude-code-transcript" &&
    left.provenance.legacySessionId === right.provenance.legacySessionId
  );
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === "number") current = Array.isArray(current) ? current[part] : undefined;
    else current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[part] : undefined;
  }
  return current;
}

function selectedText(value: unknown, index?: number): string | null {
  const leaves: string[] = [];
  stringLeaves(value, leaves);
  if (index !== undefined) return leaves[index]?.slice(0, SPAN_TEXT_CAP) ?? null;
  const text = normalizedSearchText(value);
  return text.length > 0 ? text : null;
}

function hashLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class ObservationQueue implements AsyncIterable<NormalizedSessionObservation> {
  private readonly values: NormalizedSessionObservation[] = [];
  private readonly consumerWaiters: (() => void)[] = [];
  private readonly producerWaiters: (() => void)[] = [];
  private ended = false;
  private cancelled = false;
  private error: unknown;

  push(value: NormalizedSessionObservation): void {
    if (this.cancelled) return;
    this.values.push(value);
    this.wakeConsumers();
  }

  finish(): void {
    this.ended = true;
    this.wakeAll();
  }

  fail(error: unknown): void {
    this.error = error;
    this.ended = true;
    this.wakeAll();
  }

  cancel(): void {
    this.cancelled = true;
    this.ended = true;
    this.values.splice(0);
    this.wakeAll();
  }

  async waitForCapacity(): Promise<boolean> {
    while (!this.cancelled && this.values.length >= 1) {
      await new Promise<void>((resolve) => this.producerWaiters.push(resolve));
    }
    return !this.cancelled;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<NormalizedSessionObservation> {
    while (!this.ended || this.values.length > 0) {
      if (this.values.length === 0) await new Promise<void>((resolve) => this.consumerWaiters.push(resolve));
      while (this.values.length > 0) {
        yield this.values.shift()!;
        this.wakeProducers();
      }
    }
    if (this.error) throw this.error;
  }

  private wakeConsumers(): void {
    for (const resolve of this.consumerWaiters.splice(0)) resolve();
  }

  private wakeProducers(): void {
    for (const resolve of this.producerWaiters.splice(0)) resolve();
  }

  private wakeAll(): void {
    this.wakeConsumers();
    this.wakeProducers();
  }
}
