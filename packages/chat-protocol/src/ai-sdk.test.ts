import type { UIMessage } from "ai";
import { validateUIMessages } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toUIMessage, fromUIMessage, type ChatEnvelope, type UIMessageLike } from "./ai-sdk.js";
import { chatMessage } from "./envelope.js";
import { chatPart } from "./parts.js";

/**
 * The whole dependency argument rests on this file. `ai` is a devDependency, the
 * part types are vendored, and this fixture is the thing that stops the vendored
 * subset drifting: it is typed as a real `UIMessage`, the SDK's own validator
 * accepts it, and every part survives our schemas byte for byte.
 */
const fixture = {
  id: "msg_1",
  role: "assistant",
  metadata: { sessionId: "sess_1" },
  parts: [
    { type: "step-start" },
    {
      type: "reasoning",
      text: "the branch has to exist first",
      state: "done",
      providerMetadata: { anthropic: { signature: "b64-opaque" } },
    },
    { type: "text", text: "Running it now.", state: "done" },
    {
      type: "tool-gate",
      toolCallId: "g1",
      state: "approval-requested",
      input: { prompt: "which branch?" },
      approval: { id: "g1", descriptor: { type: "object" } },
      callProviderMetadata: { anthropic: { cacheControl: "ephemeral" } },
    },
    { type: "source-url", sourceId: "s1", url: "https://example.com" },
    { type: "file", mediaType: "image/png", url: "https://example.com/a.png" },
    { type: "data-slot", id: "d1", data: { slot: "primary" } },
  ],
} satisfies UIMessage<Record<string, unknown>>;

const envelope: ChatEnvelope = {
  threadId: "t1",
  authorId: "runner",
  createdAt: "2026-09-15T10:00:00.000Z",
};

describe("the vendored AI SDK subset", () => {
  it("holds a fixture the ai SDK's own validator accepts", async () => {
    const validated = await validateUIMessages({
      messages: [fixture],
      tools: { gate: { inputSchema: z.object({ prompt: z.string() }) } },
    });
    expect(validated).toEqual([fixture]);
  });

  it("parses every part of that fixture without stripping a field", () => {
    for (const part of fixture.parts) expect(chatPart.parse(part)).toEqual(part);
  });
});

describe("the envelope", () => {
  it("is all that separates a ChatMessage from a plain UIMessage", () => {
    const message = fromUIMessage(fixture, envelope);
    expect(chatMessage.safeParse(message).success).toBe(true);
    expect(toUIMessage(message)).toEqual(fixture);
  });

  it("never lets a UIMessage off the wire assert its own provenance", () => {
    const wire = { ...fixture, provenance: { authored: "human" } } as unknown as UIMessageLike;
    expect(fromUIMessage(wire, envelope).provenance).toBeUndefined();
  });
});
