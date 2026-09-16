import { describe, expect, it } from "vitest";
import { chatMessage } from "../envelope.js";
import { GATE_PART_TYPE, fromHitlGate, toHitlAnswer, type GateSnapshot } from "./hitl.js";

const context = { threadId: "harness", authorId: "runner" };
const schema = { type: "object", properties: { pick: { type: "string" } } };

const pending: GateSnapshot = {
  id: "g1",
  prompt: "which branch?",
  schema,
  status: "pending",
  createdAt: "2026-09-15T10:00:00.000Z",
};

describe("the hitl round trip", () => {
  it("renders a pending gate as an approval request carrying its JSON Schema", () => {
    const message = fromHitlGate(pending, context);
    const [part] = message.parts;

    expect(part).toEqual({
      type: GATE_PART_TYPE,
      toolCallId: "g1",
      input: { prompt: "which branch?", schema },
      state: "approval-requested",
      approval: { id: "g1", descriptor: schema },
    });
    expect(chatMessage.safeParse(message).success).toBe(true);
    expect(toHitlAnswer(message)).toBeUndefined();
  });

  it("reads a resolved gate back as the accept payload that opened it", () => {
    const payload = { pick: "main" };
    const message = fromHitlGate({ ...pending, status: "resolved", payload }, context);
    expect(toHitlAnswer(message)).toEqual({ action: "accept", gateId: "g1", payload });
  });

  it("reads a cancelled gate back as a decline carrying its reason", () => {
    const message = fromHitlGate({ ...pending, status: "cancelled", reason: "superseded" }, context);
    expect(toHitlAnswer(message)).toEqual({ action: "decline", gateId: "g1", reason: "superseded" });
  });

  it("keeps expiry distinguishable from a cancellation", () => {
    const message = fromHitlGate({ ...pending, status: "expired" }, context);
    expect(toHitlAnswer(message)).toEqual({ action: "decline", gateId: "g1", reason: "expired" });
  });

  it("ignores a message with no gate part", () => {
    const message = fromHitlGate(pending, context);
    expect(toHitlAnswer({ ...message, parts: [{ type: "text", text: "hi" }] })).toBeUndefined();
  });
});
