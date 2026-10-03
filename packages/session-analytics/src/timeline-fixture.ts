import type { ConversationIdentity } from "@titan-design/agent-protocol";
import type { NormalizedObservationBase, NormalizedSessionObservation, SessionSourceDescriptor } from "@titan-design/session-read";
import type { PriceRow } from "./prices.js";

/** Hand-written observations for the timeline tests. Every string here is invented; none comes from a transcript. */
export const CONVERSATION: ConversationIdentity = { harness: "claude-code", namespace: "fixture-host", nativeId: "session-a" };

export const TEST_MODEL = "fixture-model";

/** Round rates, so a test can state a cost by hand. */
export const TEST_PRICES: readonly PriceRow[] = [
  { modelPrefix: TEST_MODEL, effectiveFrom: "2026-01-01", input: 1, cacheRead: 0.1, cacheWrite5m: 2, cacheWrite1h: 4, output: 5 },
];

const SOURCE: SessionSourceDescriptor = {
  sourceId: "fixture-source",
  harness: CONVERSATION.harness,
  format: "claude-code-jsonl",
  formatVersion: null,
  path: "fixture.jsonl",
  namespace: CONVERSATION.namespace,
  conversation: CONVERSATION,
  provenance: { kind: "claude-code-transcript", legacySessionId: CONVERSATION.nativeId },
};

export interface UsageCounts {
  /** Fresh input, before cache reads and writes are added to the prompt total. */
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  output: number;
  model?: string | null;
}

/** Builders that hand out one transcript line per call, at rising byte offsets. */
export class TimelineFixture {
  private offset = 0;

  constructor(private readonly conversation: ConversationIdentity = CONVERSATION) {}

  user(ts: string | null, text: string, extra: Partial<NormalizedObservationBase> = {}): NormalizedSessionObservation {
    return { ...this.base(ts), ...extra, kind: "message", role: "user", item: this.item(), representation: "canonical", content: this.text(text) };
  }

  assistant(ts: string | null, text: string, extra: Partial<NormalizedObservationBase> = {}): NormalizedSessionObservation {
    return { ...this.base(ts), ...extra, kind: "message", role: "assistant", item: this.item(), representation: "canonical", content: this.text(text) };
  }

  call(ts: string | null, id: string, name: string, input: unknown, extra: Partial<NormalizedObservationBase> = {}): NormalizedSessionObservation {
    return { ...this.base(ts), ...extra, kind: "tool_call", call: this.callId(id), item: null, name, namespace: null, input, inputLocator: null };
  }

  result(ts: string | null, id: string, isError: boolean | null, output: unknown = "ok"): NormalizedSessionObservation {
    return { ...this.base(ts), kind: "tool_result", call: this.callId(id), item: null, output, outputLocator: null, isError };
  }

  usage(ts: string | null, responseId: string, counts: UsageCounts): NormalizedSessionObservation {
    const cachedInput = counts.cacheRead ?? 0;
    const cacheWriteInput = counts.cacheWrite ?? 0;
    const input = counts.input + cachedInput + cacheWriteInput;
    const tokens = { input, output: counts.output, cachedInput, cacheWriteInput, reasoningOutput: null, total: input + counts.output };
    const model = counts.model === undefined ? TEST_MODEL : counts.model;
    return {
      ...this.base(ts),
      kind: "usage",
      measurement: { kind: "delta", responseId, model, tokens, cost: null, source: "fixture" },
      response: { conversation: this.conversation, kind: "response", nativeId: responseId },
      turn: null,
    };
  }

  snapshot(ts: string | null, sequence: number, input: number, output: number): NormalizedSessionObservation {
    const tokens = { input, output, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: input + output };
    return {
      ...this.base(ts),
      kind: "usage",
      measurement: { kind: "snapshot", scope: "conversation", scopeId: this.conversation.nativeId, epoch: "epoch-0", sequence, model: null, tokens, cost: null, source: "fixture" },
      response: null,
      turn: null,
    };
  }

  compaction(ts: string | null, summary?: string): NormalizedSessionObservation {
    const nativeExtensions = summary === undefined ? {} : { nativeExtensions: [{ name: "compactionSummary", value: summary }] };
    return { ...this.base(ts), ...nativeExtensions, kind: "compaction", turn: null, item: null, encrypted: null, usageEpochAfter: null };
  }

  private base(ts: string | null): NormalizedObservationBase {
    const byteOffset = this.offset;
    this.offset += 100;
    const line = { sourceId: SOURCE.sourceId, byteOffset, byteLength: 99, contentHash: "fixture", lineNumber: null, nativeOrdinal: null };
    return {
      id: { sourceId: SOURCE.sourceId, byteOffset, subrecordIndex: 0 },
      conversation: this.conversation,
      historyOrigin: null,
      timestamp: ts,
      evidence: { line, subrecord: { index: 0, path: [] } },
    };
  }

  private item() {
    return { conversation: this.conversation, kind: "item" as const, nativeId: `item-${this.offset}` };
  }

  private callId(id: string) {
    return { conversation: this.conversation, kind: "call" as const, nativeId: id };
  }

  private text(text: string) {
    const evidence = { line: { sourceId: SOURCE.sourceId, byteOffset: 0, byteLength: 99, contentHash: "fixture", lineNumber: null, nativeOrdinal: null }, subrecord: { index: 0, path: [] } };
    return [{ kind: "text" as const, text, locator: { source: SOURCE, evidence, selector: { kind: "subrecord-text" as const, path: [] } } }];
  }
}

export const SIDECHAIN = { nativeExtensions: [{ name: "isSidechain", value: true }] };

/**
 * A two-turn session that starts at 23:58 UTC and ends at 00:15 the next day, with a
 * 13-minute idle stretch after midnight and one compaction in the second turn.
 */
export function midnightSession(): NormalizedSessionObservation[] {
  const f = new TimelineFixture();
  return [
    f.user("2026-03-01T23:58:10Z", "run the build"),
    f.assistant("2026-03-01T23:58:20Z", "Starting the build."),
    f.call("2026-03-01T23:58:20Z", "c1", "Bash", { command: "pnpm build" }),
    f.usage("2026-03-01T23:58:20Z", "r1", { input: 1_000_000, output: 200_000 }),
    f.result("2026-03-01T23:58:50Z", "c1", false),
    f.call("2026-03-01T23:59:30Z", "c2", "Read", { file_path: "/repo/src/app.ts" }),
    f.usage("2026-03-01T23:59:30Z", "r2", { input: 0, cacheRead: 1_000_000, output: 0 }),
    f.result("2026-03-01T23:59:40Z", "c2", true, "File does not exist."),
    f.call("2026-03-02T00:00:15Z", "c3", "Edit", { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" }),
    f.usage("2026-03-02T00:00:15Z", "r3", { input: 0, cacheWrite: 500_000, output: 0 }),
    f.result("2026-03-02T00:00:20Z", "c3", false),
    f.assistant("2026-03-02T00:01:05Z", "The build passes."),
    f.usage("2026-03-02T00:01:05Z", "r4", { input: 0, output: 100_000 }),
    f.user("2026-03-02T00:14:05Z", "now run the tests"),
    f.call("2026-03-02T00:14:10Z", "c4", "Agent", { description: "run the tests", prompt: "Run the test suite." }),
    f.usage("2026-03-02T00:14:10Z", "r5", { input: 2_000_000, output: 0 }),
    f.compaction("2026-03-02T00:14:30Z"),
    f.usage("2026-03-02T00:14:40Z", "r6", { input: 100_000, output: 0 }),
    f.result("2026-03-02T00:15:00Z", "c4", false),
  ];
}
