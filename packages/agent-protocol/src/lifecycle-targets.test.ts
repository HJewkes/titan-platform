import { describe, expect, it } from "vitest";
import type { ConversationIdentity, HandoffIdentity, LifecycleExecutionTarget } from "./index.js";
import { T1, T2, apply, event, expectCode, fence, prepare } from "./test-fixtures.js";

const parent: ConversationIdentity = { harness: "codex", namespace: "local", nativeId: "parent-thread" };
const successor: ConversationIdentity = { harness: "codex", namespace: "local", nativeId: "successor-thread" };
const handoff = (overrides: Partial<HandoffIdentity> = {}): HandoffIdentity => ({
  handoffId: "msg-1",
  lineageId: "agent-0",
  generation: 2,
  predecessor: { agent: { agentId: "agent-0" }, conversation: parent },
  brief: { ref: "event:msg-1", sha256: "a".repeat(64), bytes: 812 },
  ...overrides,
});

function prepared(target: LifecycleExecutionTarget, overrides: Parameters<typeof prepare>[0] = {}) {
  return apply(undefined, prepare({ target, ...overrides }));
}

function identify(target: LifecycleExecutionTarget, conversation: ConversationIdentity) {
  const record = apply(prepared(target), event("begin_dispatch", 1, T1, { fence }));
  return apply(record, event("identify_conversation", 2, T2, { fence, conversation }));
}

describe("pinned fresh target", () => {
  const pinned: LifecycleExecutionTarget = { kind: "fresh", namespace: "local", pinnedNativeId: "pinned-id" };

  it("records the pinned conversation at prepare and refuses another observed id", () => {
    const record = prepared(pinned);

    expect(record.execution.conversation).toEqual({ harness: "codex", namespace: "local", nativeId: "pinned-id" });
    expectCode(() => identify(pinned, { ...successor, nativeId: "other-id" }), "invalid_transition");
  });

  it("refuses a caller conversation that differs from the pin", () => {
    const execution = { executionId: "execution-1", conversation: { ...successor, nativeId: "other-id" } };

    expectCode(() => prepared(pinned, { execution }), "invalid_transition");
  });

  it("still refuses a caller conversation on an unpinned fresh target", () => {
    const execution = { executionId: "execution-1", conversation: successor };

    expectCode(() => prepared({ kind: "fresh", namespace: "local" }, { execution }), "invalid_transition");
  });
});

describe("fork target", () => {
  const fork: LifecycleExecutionTarget = { kind: "fork", namespace: "local", parent };

  it("binds a new conversation in its namespace", () => {
    expect(identify(fork, successor).execution.conversation).toEqual(successor);
  });

  it.each([
    ["the parent conversation", parent],
    ["a conversation outside the namespace", { ...successor, namespace: "other-host" }],
  ])("refuses %s", (_, conversation) => {
    expectCode(() => identify(fork, conversation), "invalid_transition");
  });
});

describe("handoff target", () => {
  const target = (overrides: Partial<HandoffIdentity> = {}): LifecycleExecutionTarget =>
    ({ kind: "handoff", namespace: "local", handoff: handoff(overrides) });

  it("binds a successor conversation and keeps a cross-harness predecessor legal", () => {
    const crossHarness = target({ predecessor: { agent: { agentId: "agent-0" }, conversation: { ...parent, harness: "claude-code" } } });

    expect(identify(target(), successor).execution.conversation).toEqual(successor);
    expect(prepared(crossHarness).target).toEqual(crossHarness);
  });

  it.each([
    ["the predecessor's agent", () => prepared(target(), { agent: { agentId: "agent-0" } })],
    ["no agent", () => prepared(target(), { agent: undefined })],
    ["generation 1", () => prepared(target({ generation: 1 }))],
    ["an uppercase sha256", () => prepared(target({ brief: { ref: "event:msg-1", sha256: "A".repeat(64), bytes: 812 } }))],
    ["an empty lineageId", () => prepared(target({ lineageId: "" }))],
    ["a negative brief size", () => prepared(target({ brief: { ref: "event:msg-1", sha256: "a".repeat(64), bytes: -1 } }))],
    ["the predecessor's conversation", () => identify(target(), parent)],
  ])("refuses %s", (_, attempt) => {
    expectCode(attempt, "invalid_transition");
  });
});

describe("target cloning", () => {
  it("keeps the record unchanged when the caller mutates its fork parent or handoff brief", () => {
    const forkParent = { ...parent };
    const brief = { ref: "event:msg-1", sha256: "a".repeat(64), bytes: 812 };
    const predecessor = { agent: { agentId: "agent-0" }, conversation: { ...parent } };
    const fork = prepared({ kind: "fork", namespace: "local", parent: forkParent });
    const succeeded = prepared({ kind: "handoff", namespace: "local", handoff: handoff({ brief, predecessor }) });

    forkParent.nativeId = "mutated";
    brief.sha256 = "b".repeat(64);
    predecessor.agent.agentId = "mutated";
    predecessor.conversation.nativeId = "mutated";

    expect(fork.target).toEqual({ kind: "fork", namespace: "local", parent });
    expect(succeeded.target).toEqual({ kind: "handoff", namespace: "local", handoff: handoff() });
  });
});
