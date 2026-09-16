import { describe, expect, it } from "vitest";
import { chatPart, dataPart, toolPart } from "./parts.js";

describe("data parts", () => {
  it("accepts an identifier key", () => {
    const parsed = dataPart.safeParse({ type: "data-gate_ref", data: { gateId: "g1" } });
    expect(parsed.success).toBe(true);
  });

  it("rejects a key with a hyphen after the prefix, which a channel would drop silently", () => {
    const parsed = dataPart.safeParse({ type: "data-gate-ref", data: {} });
    expect(parsed.success).toBe(false);
  });

  it("rejects a key that is not a data part at all", () => {
    expect(dataPart.safeParse({ type: "gate", data: {} }).success).toBe(false);
  });
});

describe("tool parts", () => {
  it("accepts an approval request", () => {
    const parsed = toolPart.safeParse({
      type: "tool-Bash",
      toolCallId: "call_1",
      state: "approval-requested",
      input: { command: "ls" },
      approval: { id: "appr_1" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an approval-requested part with no approval", () => {
    const parsed = toolPart.safeParse({
      type: "tool-Bash",
      toolCallId: "call_1",
      state: "approval-requested",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a denied output that claims it was approved", () => {
    const parsed = toolPart.safeParse({
      type: "tool-Bash",
      toolCallId: "call_1",
      state: "output-denied",
      approval: { id: "appr_1", approved: true },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an errored output with no errorText", () => {
    const parsed = toolPart.safeParse({
      type: "tool-Bash",
      toolCallId: "call_1",
      state: "output-error",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("the part union", () => {
  it("parses every vendored part kind", () => {
    const parts = [
      { type: "text", text: "hi", state: "done" },
      { type: "reasoning", text: "thinking", providerMetadata: { anthropic: { signature: "opaque" } } },
      { type: "source-url", sourceId: "s1", url: "https://example.com" },
      { type: "source-document", sourceId: "s2", mediaType: "application/pdf", title: "spec" },
      { type: "file", mediaType: "image/png", url: "https://example.com/a.png" },
      { type: "step-start" },
      { type: "tool-Read", toolCallId: "c1", state: "input-available", input: { path: "a.ts" } },
      { type: "data-slot", data: { slot: "primary" } },
    ];
    for (const part of parts) expect(chatPart.safeParse(part).success).toBe(true);
  });

  it("keeps an opaque reasoning signature verbatim", () => {
    const part = { type: "reasoning", text: "t", providerMetadata: { anthropic: { signature: "abc123" } } };
    expect(chatPart.parse(part)).toEqual(part);
  });
});
