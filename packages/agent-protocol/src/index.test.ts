import { describe, expect, expectTypeOf, it } from "vitest";
import { conversationItemRef, conversationRef, type AgentIdentity, type ExecutionIdentity } from "./index.js";

const claude = { harness: "claude-code", namespace: "local", nativeId: "same-id" };

describe("conversation references", () => {
  it("separates harnesses and hosts even when native IDs match", () => {
    const refs = [claude, { ...claude, harness: "codex" }, { ...claude, namespace: "other-host" }].map(conversationRef);
    expect(new Set(refs).size).toBe(3);
    expect(refs[0]).not.toBe(`session:${claude.nativeId}`);
  });

  it("encodes delimiters and Unicode without collapsing distinct identities", () => {
    expect(conversationRef({ harness: "a:b", namespace: "c", nativeId: "é/%" })).toBe("conversation:a%3Ab:c:%C3%A9%2F%25");
    expect(conversationRef({ harness: "a", namespace: "b:c", nativeId: "é/%" })).not.toBe(conversationRef({ harness: "a:b", namespace: "c", nativeId: "é/%" }));
  });

  it("scopes native item IDs by conversation and category", () => {
    expect(conversationItemRef(claude, "call", "1")).not.toBe(conversationItemRef(claude, "turn", "1"));
    expect(conversationItemRef(claude, "call", "1")).not.toBe(conversationItemRef({ ...claude, nativeId: "child" }, "call", "1"));
  });

  it.each(["", "  "])("rejects an unusable identity component %j", (nativeId) => {
    expect(() => conversationRef({ ...claude, nativeId })).toThrow(TypeError);
    expect(() => conversationItemRef(claude, "call", nativeId)).toThrow(TypeError);
  });
});

it("does not interchange durable agent and live execution identities", () => {
  expectTypeOf<AgentIdentity>().not.toExtend<ExecutionIdentity>();
  expectTypeOf<ExecutionIdentity>().not.toExtend<AgentIdentity>();
});
