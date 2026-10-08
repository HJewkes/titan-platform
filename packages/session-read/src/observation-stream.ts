import { createHash } from "node:crypto";
import { prefixHash, readJsonLines } from "@titan-design/locator";
import type {
  LocatedSourceLine,
  NormalizedSessionObservation,
  ResumeBoundary,
  SessionFormatDecoder,
  SessionSourceDescriptor,
  SessionSourceProvenance,
  SourceTextLocator,
} from "./normalized.js";
import type { ReadSessionObservationOptions, SessionObservationReadResult } from "./session-observations.js";
import { normalizedSearchText, SPAN_TEXT_CAP, stringLeaves } from "./text.js";

/** Prefix-replay read with bounded observation buffering and rewrite detection, shared by every harness reader. */
export async function* streamObservations(
  source: SessionSourceDescriptor,
  decoder: SessionFormatDecoder<never>,
  options: ReadSessionObservationOptions,
  onDone?: (result: SessionObservationReadResult) => void,
): AsyncGenerator<NormalizedSessionObservation> {
  const resume = await resolveResume(source.path, options.from);
  const queue = new ObservationQueue();
  const lines = locatedLines(source, queue, options.untilByteOffset);
  const replay = { strategy: "replay-prefix", readFromByteOffset: 0, emitFrom: resume.emitFrom, checkpoint: null } as const;
  const decoding = decoder.decode({ source, lines, resume: replay }, (observation) => queue.push(observation));
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

/**
 * The one source identity rule for locator readback. Without fresh `sources` the locator's
 * own snapshot is used. With them, exactly one fresh source must carry the locator's
 * `sourceId`, harness, format, namespace, conversation identity and provenance (its kind and
 * native identity key). Only the path may differ, because sources move between discovery passes.
 */
export function resolveSource(locator: SourceTextLocator, sources?: readonly SessionSourceDescriptor[]): SessionSourceDescriptor | null {
  if (locator.evidence.line.sourceId !== locator.source.sourceId) return null;
  if (!sources) return locator.source;
  const matches = sources.filter((source) => sameIdentity(source, locator.source));
  return matches.length === 1 ? matches[0]! : null;
}

/** Text selected by a locator from the parsed record of its line. */
export function selectedText(record: unknown, selector: SourceTextLocator["selector"]): string | null {
  const value = valueAt(record, selector.path);
  const leaves: string[] = [];
  stringLeaves(value, leaves);
  if (selector.textIndex !== undefined) return leaves[selector.textIndex]?.slice(0, SPAN_TEXT_CAP) ?? null;
  const text = normalizedSearchText(value);
  return text.length > 0 ? text : null;
}

export function hashLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

function sameIdentity(left: SessionSourceDescriptor, right: SessionSourceDescriptor): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.harness === right.harness &&
    left.format === right.format &&
    left.namespace === right.namespace &&
    left.conversation.harness === right.conversation.harness &&
    left.conversation.namespace === right.conversation.namespace &&
    left.conversation.nativeId === right.conversation.nativeId &&
    left.provenance.kind === right.provenance.kind &&
    provenanceKey(left.provenance) === provenanceKey(right.provenance)
  );
}

function provenanceKey(provenance: SessionSourceProvenance): string | null {
  if (provenance.kind === "claude-code-transcript") return provenance.legacySessionId;
  if (provenance.kind === "codex-rollout") return provenance.sessionTreeId;
  return provenance.name;
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === "number") current = Array.isArray(current) ? current[part] : undefined;
    else current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[part] : undefined;
  }
  return current;
}

async function resolveResume(filePath: string, from?: ResumeBoundary): Promise<{ emitFrom: ResumeBoundary; restarted: boolean }> {
  const zero = { byteOffset: 0, prefixHash: await prefixHash(filePath, 0) };
  if (!from || from.byteOffset === 0) return { emitFrom: zero, restarted: false };
  const current = await prefixHash(filePath, from.byteOffset);
  return current === from.prefixHash ? { emitFrom: from, restarted: false } : { emitFrom: zero, restarted: true };
}

async function* locatedLines(source: SessionSourceDescriptor, queue: ObservationQueue, until?: number): AsyncGenerator<LocatedSourceLine> {
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
