import { describe, expect, it } from "vitest";
import { inboundChatMessage, type ChatMessage } from "../envelope.js";
import { deliveryFromSendResult, fromMessagingInbound, toMessagingOutbound } from "./messaging.js";

const at = "2026-09-15T10:00:00.000Z";
const context = { threadId: "coach", authorId: "lifter", createdAt: at };

describe("the messaging round trip", () => {
  it("returns the same text after a trip out to the transport and back", () => {
    const inbound = { status: "accepted" as const, handle: "+15550000000", guid: "g1", text: "sunday?" };
    const message = fromMessagingInbound(inbound, context);
    const { send, dropped } = toMessagingOutbound(message, inbound.handle);

    expect(send).toEqual({ handle: inbound.handle, text: inbound.text });
    expect(dropped).toEqual([]);
    expect(fromMessagingInbound({ ...inbound, text: send.text }, context)).toEqual(message);
  });

  it("uses the transport dedupe key as the message id", () => {
    const message = fromMessagingInbound(
      { status: "accepted", handle: "h", guid: "g-dedupe", text: "x" },
      context,
    );
    expect(message.id).toBe("g-dedupe");
  });

  it("marks an inbound message human-authored, because a human typed it", () => {
    const message = fromMessagingInbound({ status: "accepted", handle: "h", guid: "g", text: "x" }, context);
    expect(message.provenance).toEqual({ authored: "human" });
    expect(inboundChatMessage.safeParse(message).success).toBe(false);
  });

  it("reports the part types the seam cannot carry instead of dropping them silently", () => {
    const message: ChatMessage = {
      id: "m1",
      threadId: "coach",
      authorId: "coach",
      role: "assistant",
      createdAt: at,
      parts: [
        { type: "text", text: "here" },
        { type: "file", mediaType: "image/png", url: "https://example.com/a.png" },
        { type: "text", text: "you go" },
      ],
    };
    const { send, dropped } = toMessagingOutbound(message, "h");
    expect(send.text).toBe("here\n\nyou go");
    expect(dropped).toEqual(["file"]);
  });
});

describe("deliveryFromSendResult", () => {
  it("caps a successful send at accepted", () => {
    expect(deliveryFromSendResult({ ok: true, messageGuid: "g" }, "p2", at)).toEqual({
      participantId: "p2",
      status: "accepted",
      at,
    });
  });

  it("carries the send error kind as the delivery reason", () => {
    expect(deliveryFromSendResult({ ok: false, error: { kind: "no-chat" } }, "p2", at)).toEqual({
      participantId: "p2",
      status: "undeliverable",
      at,
      reason: "no-chat",
    });
  });
});
