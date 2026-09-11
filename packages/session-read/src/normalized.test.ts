import type { TokenCounts } from "@titan-design/agent-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  DecodeRequest,
  DecodeResume,
  NormalizedMessageObservation,
  NormalizedMetadataObservation,
  NormalizedSessionObservation,
  NormalizedUsageObservation,
  SessionFormatDecoder,
  SessionSourceDescriptor,
  SourceEvidence,
} from "./normalized.js";
import { legacyClaudeSessionRef, scopedConversationItemRef } from "./normalized.js";
import { sessionRef } from "./refs.js";

const tokens = {
  input: 13,
  output: 8,
  cachedInput: 5,
  cacheWriteInput: null,
  reasoningOutput: 3,
  total: 21,
} satisfies TokenCounts;

const claudeSource = {
  sourceId: "claude:projects/demo/session-1.jsonl",
  harness: "claude-code",
  format: "claude-code-jsonl",
  formatVersion: "1",
  path: "/home/demo/.claude/projects/demo/session-1.jsonl",
  namespace: "workstation-a",
  conversation: { harness: "claude-code", namespace: "workstation-a", nativeId: "session-1" },
  provenance: { kind: "claude-code-transcript", legacySessionId: "session-1" },
} satisfies SessionSourceDescriptor;

const codexSource = {
  sourceId: "codex:sessions/2026/09/11/child.jsonl",
  harness: "codex",
  format: "codex-rollout-jsonl",
  formatVersion: "0.154.0-alpha.6.1",
  path: "/home/demo/.codex/sessions/2026/09/11/child.jsonl",
  namespace: "workstation-a",
  conversation: { harness: "codex", namespace: "workstation-a", nativeId: "child-thread" },
  provenance: { kind: "codex-rollout", sessionTreeId: "root-thread", historyMode: "paginated" },
} satisfies SessionSourceDescriptor;

const evidence = (sourceId: string, byteOffset: number, index: number, path: readonly (string | number)[]): SourceEvidence => ({
  line: { sourceId, byteOffset, byteLength: 180, lineNumber: 4, nativeOrdinal: 3 },
  subrecord: { index, path },
});

const claudeMessage = {
  id: { sourceId: claudeSource.sourceId, byteOffset: 120, subrecordIndex: 0 },
  kind: "message",
  conversation: claudeSource.conversation,
  historyOrigin: null,
  timestamp: "2026-09-11T10:00:00Z",
  evidence: evidence(claudeSource.sourceId, 120, 0, ["message", "content", 0]),
  role: "assistant",
  item: { conversation: claudeSource.conversation, kind: "item", nativeId: "message-1" },
  representation: "canonical",
  content: [
    {
      kind: "text",
      text: "Done.",
      locator: {
        source: claudeSource,
        evidence: evidence(claudeSource.sourceId, 120, 0, ["message", "content", 0]),
        selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
      },
    },
  ],
} satisfies NormalizedMessageObservation;

const codexTurn = { conversation: codexSource.conversation, kind: "turn", nativeId: "turn-7" } as const;
const codexCall = { conversation: codexSource.conversation, kind: "call", nativeId: "call-2" } as const;
const codexRootConversation = { harness: "codex", namespace: "workstation-a", nativeId: "root-thread" } as const;

const codexObservations: readonly NormalizedSessionObservation[] = [
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 0, subrecordIndex: 0 },
    kind: "lineage",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: "2026-09-11T10:01:00Z",
    evidence: evidence(codexSource.sourceId, 0, 0, ["payload", "parent_thread_id"]),
    relationship: "parent",
    relatedConversation: codexRootConversation,
    copiedThroughTurn: null,
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 300, subrecordIndex: 0 },
    kind: "native_turn",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: "2026-09-11T10:01:01Z",
    evidence: evidence(codexSource.sourceId, 300, 0, ["payload", "turn_id"]),
    turn: codexTurn,
    rootTurn: { conversation: codexRootConversation, kind: "turn", nativeId: "root-turn-1" },
    phase: "started",
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 500, subrecordIndex: 0 },
    kind: "tool_call",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: "2026-09-11T10:01:02Z",
    evidence: evidence(codexSource.sourceId, 500, 0, ["payload", "calls", 0]),
    call: codexCall,
    item: { conversation: codexSource.conversation, kind: "item", nativeId: "item-4" },
    name: "functions.exec",
    namespace: null,
    input: { command: "pwd" },
    inputLocator: {
      source: codexSource,
      evidence: evidence(codexSource.sourceId, 500, 0, ["payload", "calls", 0]),
      selector: { kind: "subrecord-text", path: ["payload", "calls", 0, "input"] },
    },
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 500, subrecordIndex: 1 },
    kind: "metadata",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: "2026-09-11T10:01:02Z",
    evidence: evidence(codexSource.sourceId, 500, 1, ["payload", "future_flag"]),
    scope: "turn",
    turn: codexTurn,
    entries: [{ name: "future_flag", value: { mode: "new" }, meaning: "native" }],
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 700, subrecordIndex: 0 },
    kind: "tool_result",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: "2026-09-11T10:01:03Z",
    evidence: evidence(codexSource.sourceId, 700, 0, ["payload"]),
    call: codexCall,
    item: null,
    output: "/worktree",
    outputLocator: {
      source: codexSource,
      evidence: evidence(codexSource.sourceId, 700, 0, ["payload"]),
      selector: { kind: "subrecord-text", path: ["payload", "output"] },
    },
    isError: false,
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 900, subrecordIndex: 0 },
    kind: "usage",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: "2026-09-11T10:01:04Z",
    evidence: evidence(codexSource.sourceId, 900, 0, ["payload", "usage"]),
    measurement: { kind: "delta", responseId: "response-3", model: "gpt-6", tokens, cost: null, source: "token_usage_record.usage" },
    response: { conversation: codexSource.conversation, kind: "response", nativeId: "response-3" },
    turn: codexTurn,
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 900, subrecordIndex: 1 },
    kind: "usage",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: "2026-09-11T10:01:04Z",
    evidence: evidence(codexSource.sourceId, 900, 1, ["payload", "thread_token_usage"]),
    measurement: {
      kind: "snapshot",
      scope: "conversation",
      scopeId: "child-thread",
      epoch: "before-compaction-1",
      sequence: 3,
      model: "gpt-6",
      tokens,
      cost: null,
      source: "token_usage_record.thread_token_usage",
    },
    response: null,
    turn: codexTurn,
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 1100, subrecordIndex: 0 },
    kind: "compaction",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: null,
    evidence: evidence(codexSource.sourceId, 1100, 0, ["payload"]),
    turn: codexTurn,
    item: null,
    encrypted: true,
    usageEpochAfter: "after-compaction-1",
  },
  {
    id: { sourceId: codexSource.sourceId, byteOffset: 1300, subrecordIndex: 0 },
    kind: "unknown",
    conversation: codexSource.conversation,
    historyOrigin: null,
    timestamp: null,
    evidence: evidence(codexSource.sourceId, 1300, 0, ["payload"]),
    nativeKind: "future_rollout_kind",
    value: { retained: true },
  },
];

describe("normalized session contracts", () => {
  it("keeps legacy Claude refs explicit and leaves sessionRef unchanged", () => {
    expect(legacyClaudeSessionRef(claudeSource)).toBe("session:session-1");
    expect(legacyClaudeSessionRef(codexSource)).toBeNull();
    expect(legacyClaudeSessionRef({ ...claudeSource, harness: "codex" })).toBeNull();
    expect(legacyClaudeSessionRef({ ...claudeSource, format: "codex-rollout-jsonl" })).toBeNull();
    expect(legacyClaudeSessionRef({ ...claudeSource, namespace: "other-host" })).toBeNull();
    expect(legacyClaudeSessionRef({ ...claudeSource, provenance: { kind: "claude-code-transcript", legacySessionId: "other-session" } })).toBeNull();
    expect(sessionRef("session-1")).toBe("session:session-1");
  });

  it("keeps a Codex thread distinct from its session tree", () => {
    expect(codexSource.conversation.nativeId).toBe("child-thread");
    expect(codexSource.provenance).toMatchObject({ sessionTreeId: "root-thread" });
    expect(scopedConversationItemRef(codexCall)).toContain(":child-thread:");
  });

  it("allows multiple semantic observations from one source line", () => {
    const siblings = codexObservations.filter((observation) => observation.evidence.line.byteOffset === 500);
    expect(siblings.map((observation) => observation.id.subrecordIndex)).toEqual([0, 1]);
    expect(siblings.map((observation) => observation.kind)).toEqual(["tool_call", "metadata"]);
  });

  it("distinguishes response deltas from ordered cumulative snapshots", () => {
    const usage = codexObservations.filter((observation): observation is NormalizedUsageObservation => observation.kind === "usage");
    expect(usage.map((observation) => observation.measurement.kind)).toEqual(["delta", "snapshot"]);
    expect(usage[0]?.response?.nativeId).toBe("response-3");
    expect(usage[1]?.response).toBeNull();
  });

  it("preserves unknown metadata and unknown native observations", () => {
    const metadata = codexObservations.find((observation): observation is NormalizedMetadataObservation => observation.kind === "metadata");
    expect(metadata?.entries).toEqual([{ name: "future_flag", value: { mode: "new" }, meaning: "native" }]);
    expect(codexObservations.at(-1)).toMatchObject({ kind: "unknown", nativeKind: "future_rollout_kind" });
  });

  it("provides compiling Claude and Codex conformance examples", () => {
    expectTypeOf(claudeMessage).toMatchTypeOf<NormalizedSessionObservation>();
    expectTypeOf(codexObservations).toMatchTypeOf<readonly NormalizedSessionObservation[]>();
  });
});

interface CodexCheckpointState {
  activeTurnId: string | null;
  model: string | null;
}

describe("decoder contract", () => {
  it("types prefix replay and checkpoint resume against one emission boundary", () => {
    const emitFrom = { byteOffset: 900, prefixHash: "verified-prefix" } as const;
    const replay = { strategy: "replay-prefix", readFromByteOffset: 0, emitFrom, checkpoint: null } satisfies DecodeResume<CodexCheckpointState>;
    const checkpoint = {
      strategy: "checkpoint",
      readFromByteOffset: 700,
      emitFrom,
      checkpoint: {
        decoderId: "codex-rollout",
        checkpointVersion: "1",
        sourceId: codexSource.sourceId,
        boundary: { byteOffset: 700, prefixHash: "checkpoint-prefix" },
        state: { activeTurnId: "turn-7", model: "gpt-6" },
      },
    } satisfies DecodeResume<CodexCheckpointState>;

    expect(replay.readFromByteOffset).toBe(0);
    expect(checkpoint.emitFrom).toEqual(replay.emitFrom);
    expectTypeOf<SessionFormatDecoder<CodexCheckpointState>["decode"]>().parameter(0).toMatchTypeOf<DecodeRequest<CodexCheckpointState>>();
    expectTypeOf<SessionFormatDecoder<CodexCheckpointState>["decode"]>().parameter(1).toBeCallableWith(codexObservations[0]!);
    expectTypeOf<SessionFormatDecoder<CodexCheckpointState>["readText"]>().returns.resolves.toEqualTypeOf<string | null>();
  });
});
