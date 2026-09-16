import { describe, expect, it } from "vitest";
import { chatMessage, inboundChatMessage, markHumanEndorsed, type ChatMessage } from "./envelope.js";

const base = {
  id: "m1",
  threadId: "t1",
  authorId: "p1",
  role: "user" as const,
  createdAt: "2026-09-15T10:00:00.000Z",
  parts: [{ type: "text" as const, text: "sunday?" }],
};

describe("inbound messages", () => {
  it("accepts an envelope with no provenance", () => {
    expect(inboundChatMessage.safeParse(base).success).toBe(true);
  });

  it("rejects a payload claiming a human endorsement", () => {
    const parsed = inboundChatMessage.safeParse({
      ...base,
      provenance: { authored: "agent", endorsedBy: "human", attestedBy: "broker" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a payload claiming any provenance at all", () => {
    expect(inboundChatMessage.safeParse({ ...base, provenance: { authored: "human" } }).success).toBe(false);
  });

  it("rejects a payload claiming delivery state", () => {
    const delivery = [{ participantId: "p2", status: "read", at: base.createdAt }];
    expect(inboundChatMessage.safeParse({ ...base, delivery }).success).toBe(false);
  });
});

describe("markHumanEndorsed", () => {
  it("is the only way an endorsement is minted, and does not mutate the message", () => {
    const message: ChatMessage = { ...base };
    const endorsed = markHumanEndorsed(message, "broker-1");
    expect(endorsed.provenance).toEqual({ authored: "agent", endorsedBy: "human", attestedBy: "broker-1" });
    expect(message.provenance).toBeUndefined();
    expect(chatMessage.safeParse(endorsed).success).toBe(true);
  });
});
