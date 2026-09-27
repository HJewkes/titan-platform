import { describe, expect, it } from "vitest";
import { RESERVED_CORRELATION_PREFIXES, correlationKey, type ExecutionTransition } from "./index.js";
import { T1, apply, event, expectCode, fence, prepare } from "./test-fixtures.js";

const valid = { "relay.run": "run-42", "relay.item": "42", "broker.config_dir": "/Users/me/.claude", "agent-thread.thread": "thread-7" };

describe("execution correlations", () => {
  it("stores a copy that later caller mutation cannot reach", () => {
    const input: Record<string, string> = { ...valid };
    const record = apply(undefined, prepare({ correlations: input }));

    input["relay.item"] = "mutated";

    expect(record.correlations).toEqual(valid);
    expect(Object.isFrozen(record.correlations)).toBe(true);
  });

  it.each([
    ["an unprefixed key", { relay: "x" }],
    ["an empty prefix", { ".x": "x" }],
    ["an uppercase prefix", { "Relay.item": "x" }],
    ["33 keys", Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`relay.k${index}`, "x"]))],
    ["an empty value", { "relay.item": "" }],
    ["a 513-character value", { "relay.item": "x".repeat(513) }],
  ])("rejects %s", (_, correlations) => {
    expectCode(() => apply(undefined, prepare({ correlations })), "invalid_transition");
  });

  it("reserves the broker and agent-thread prefixes", () => {
    expect(RESERVED_CORRELATION_PREFIXES).toEqual(expect.arrayContaining(["broker", "agent-thread"]));
    expect(correlationKey("agent-thread", "thread")).toBe("agent-thread.thread");
    expect(() => correlationKey("Relay", "item")).toThrow(TypeError);
  });

  it("keeps correlations fixed even when a later transition carries the field", () => {
    const record = apply(undefined, prepare({ correlations: valid }));
    const smuggled = { ...event("begin_dispatch", 1, T1, { fence }), correlations: { "relay.item": "99" } } as ExecutionTransition<string>;

    expect(apply(record, smuggled).correlations).toEqual(valid);
  });
});
