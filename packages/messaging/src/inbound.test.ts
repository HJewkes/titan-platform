import { describe, expect, it } from "vitest";
import type { SeenStore, ValidateInboundInput } from "./inbound.js";
import { MemorySeenStore, validateInbound } from "./inbound.js";

const SECRET = "path-secret-abcdef";
const LIFTER = "lifter@icloud.com";

/**
 * The message object as BlueBubbles' Postman collection documents it, wrapped
 * in the `{ type, data }` envelope WebhookService posts. Trimmed only of the
 * fields the validator never reads.
 */
const NEW_MESSAGE_EVENT = {
  type: "new-message",
  data: {
    originalROWID: 132938,
    guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEE",
    text: "ready for sunday",
    handle: {
      originalROWID: 115,
      address: LIFTER,
      country: "US",
      uncanonicalizedId: null,
    },
    handleId: 115,
    chats: [{ guid: "iMessage;+;chat1234567890" }],
    attachments: [],
    subject: null,
    error: 0,
    dateCreated: 1633920317533,
    dateRead: null,
    dateDelivered: null,
    isFromMe: false,
    isAudioMessage: false,
    itemType: 0,
  },
};

function input(overrides: Partial<ValidateInboundInput> = {}): ValidateInboundInput {
  return {
    pathSecret: SECRET,
    expectedSecret: SECRET,
    allowedHandles: [LIFTER],
    body: NEW_MESSAGE_EVENT,
    maxTextLength: 2000,
    seen: new MemorySeenStore(),
    ...overrides,
  };
}

function eventWith(data: Record<string, unknown>): unknown {
  return { ...NEW_MESSAGE_EVENT, data: { ...NEW_MESSAGE_EVENT.data, ...data } };
}

describe("validateInbound", () => {
  it("accepts a real captured new-message event from an allowed handle", async () => {
    const result = await validateInbound(input());

    expect(result).toEqual({
      status: "accepted",
      handle: LIFTER,
      guid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEE",
      text: "ready for sunday",
    });
  });

  it("rejects an otherwise valid request whose secret is one character off", async () => {
    const result = await validateInbound(input({ pathSecret: "path-secret-abcdee" }));

    expect(result).toEqual({ status: "rejected", reason: "bad-secret" });
  });

  it("rejects a wrong secret before looking at the body", async () => {
    const result = await validateInbound(
      input({ pathSecret: "wrong", body: { nonsense: true } }),
    );

    expect(result).toEqual({ status: "rejected", reason: "bad-secret" });
  });

  it("rejects an empty expected secret", async () => {
    const result = await validateInbound(
      input({ pathSecret: "", expectedSecret: "" }),
    );

    expect(result).toEqual({ status: "rejected", reason: "bad-secret" });
  });

  it("rejects a sender outside the allowlist", async () => {
    const result = await validateInbound(
      input({ body: eventWith({ handle: { address: "stranger@icloud.com" } }) }),
    );

    expect(result).toEqual({ status: "rejected", reason: "sender-not-allowed" });
  });

  it("rejects the coach's own outbound message", async () => {
    const result = await validateInbound(input({ body: eventWith({ isFromMe: true }) }));

    expect(result).toEqual({ status: "rejected", reason: "from-me" });
  });

  it("rejects a body over the length cap", async () => {
    const result = await validateInbound(
      input({ body: eventWith({ text: "x".repeat(2001) }) }),
    );

    expect(result).toEqual({ status: "rejected", reason: "too-long" });
  });

  it("rejects a payload that is not a new-message event", async () => {
    const other = await validateInbound(
      input({ body: { type: "typing-indicator", data: NEW_MESSAGE_EVENT.data } }),
    );
    const garbage = await validateInbound(input({ body: "not json at all" }));
    const noGuid = await validateInbound(input({ body: eventWith({ guid: "" }) }));

    for (const result of [other, garbage, noGuid]) {
      expect(result).toEqual({ status: "rejected", reason: "malformed" });
    }
  });

  it("rejects a message with no handle", async () => {
    const result = await validateInbound(input({ body: eventWith({ handle: null }) }));

    expect(result).toEqual({ status: "rejected", reason: "malformed" });
  });

  it("accepts a guid once and rejects the replay", async () => {
    const seen = new MemorySeenStore();

    const first = await validateInbound(input({ seen }));
    const second = await validateInbound(input({ seen }));

    expect(first.status).toBe("accepted");
    expect(second).toEqual({ status: "rejected", reason: "duplicate" });
  });

  it("awaits an async SeenStore", async () => {
    const guids = new Set<string>();
    const seen: SeenStore = {
      has: async (guid) => guids.has(guid),
      add: async (guid) => {
        guids.add(guid);
      },
    };

    expect((await validateInbound(input({ seen }))).status).toBe("accepted");
    expect(await validateInbound(input({ seen }))).toEqual({
      status: "rejected",
      reason: "duplicate",
    });
  });

  it("does not record a guid it rejected", async () => {
    const seen = new MemorySeenStore();

    await validateInbound(input({ seen, body: eventWith({ isFromMe: true }) }));

    expect(seen.has(NEW_MESSAGE_EVENT.data.guid)).toBe(false);
  });
});
