import { createHash } from "node:crypto";
import { prefixHash, readJsonLines, readLocatorText } from "@titan-design/locator";
import { CodexRolloutDecoder } from "./codex-decoder.js";
import { CODEX_ROLLOUT_FORMAT, codexSourceFromPath } from "./codex-discover.js";
import type {
  DecodeRequest,
  LocatedSourceLine,
  NormalizedSessionObservation,
  ResumeBoundary,
  SessionSourceDescriptor,
  SourceTextLocator,
} from "./normalized.js";
import { normalizedSearchText, SPAN_TEXT_CAP, stringLeaves } from "./text.js";

export interface ReadCodexOptions {
  from?: ResumeBoundary;
  /** Test seam for ending after a complete line in a growing rollout. */
  untilByteOffset?: number;
}

export interface CodexReadResult {
  startByteOffset: number;
  resumeBoundary: ResumeBoundary;
  restartedFromZero: boolean;
}

export interface ReadCodexTextOptions {
  /** Fresh discovery results let a moved active/archive source resolve by sourceId. */
  sources?: readonly SessionSourceDescriptor[];
}

/** Prefix-replay reader with byte-hash rewrite detection and streaming observation delivery. */
export async function* readCodexObservations(
  source: SessionSourceDescriptor,
  options: ReadCodexOptions = {},
  onDone?: (result: CodexReadResult) => void,
): AsyncGenerator<NormalizedSessionObservation> {
  const resume = await resolveResume(source.path, options.from);
  const queue = new ObservationQueue();
  const request: DecodeRequest<never> = {
    source,
    lines: locatedLines(source, queue, options.untilByteOffset),
    resume: { strategy: "replay-prefix", readFromByteOffset: 0, emitFrom: resume.emitFrom, checkpoint: null },
  };
  const decoding = new CodexRolloutDecoder().decode(request, (observation) => queue.push(observation));
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

/** Read only the selected semantic subrecord, never the containing JSON line. */
export async function readCodexText(locator: SourceTextLocator, options: ReadCodexTextOptions = {}): Promise<string | null> {
  try {
    if (locator.source.format !== CODEX_ROLLOUT_FORMAT || locator.source.harness !== "codex") return null;
    const source = resolveSource(locator, options.sources);
    if (!source || !(await sourceStillMatches(source))) return null;
    const line = await readLocatorText(source.path, [0, locator.evidence.line.byteOffset, locator.evidence.line.byteLength]);
    if (hashLine(line) !== locator.evidence.line.contentHash) return null;
    const record = JSON.parse(line) as unknown;
    const selected = valueAt(record, locator.selector.path);
    return selectedText(selected, locator.selector.textIndex);
  } catch {
    return null;
  }
}

async function* locatedLines(source: SessionSourceDescriptor, queue: ObservationQueue, until?: number): AsyncGenerator<LocatedSourceLine> {
  let lineNumber = 0;
  for await (const line of readJsonLines(source.path)) {
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
  const matches = sources.filter((source) => source.sourceId === locator.source.sourceId);
  return matches.length === 1 ? matches[0]! : null;
}

async function sourceStillMatches(source: SessionSourceDescriptor): Promise<boolean> {
  const current = await codexSourceFromPath(source.path, source.namespace);
  return (
    current?.sourceId === source.sourceId &&
    current.conversation.harness === source.conversation.harness &&
    current.conversation.namespace === source.conversation.namespace &&
    current.conversation.nativeId === source.conversation.nativeId
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
