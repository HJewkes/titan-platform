import { describe, expect, it } from "vitest";
import type { MessageRef, SendResult } from "./contract.js";
import { ManualClock, MockTransport } from "./mock.js";
import { fakeCallbackUpdate, fakeTextUpdate } from "./telegram-fakes.js";
import { readInbound } from "./telegram-updates.js";

function refOf(result: SendResult): MessageRef {
  if (!result.ok || !result.ref) throw new Error("expected a send that named its message");
  return result.ref;
}

describe("MockTransport interactions", () => {
  it("typing stops being visible after five seconds on the injected clock", async () => {
    const clock = new ManualClock(1000);
    const transport = new MockTransport({ now: () => clock.now() });

    await transport.chatAction({ handle: "+1", action: "typing" });
    expect(transport.typingVisible("+1")).toBe(true);

    await clock.advance(4999);
    expect(transport.typingVisible("+1")).toBe(true);

    await clock.advance(1);
    expect(transport.typingVisible("+1")).toBe(false);
  });

  it("a send to the same handle clears the typing indicator", async () => {
    const clock = new ManualClock(0);
    const transport = new MockTransport({ now: () => clock.now() });

    await transport.chatAction({ handle: "+1", action: "typing" });
    await transport.send({ handle: "+1", text: "here it is" });

    expect(transport.typingVisible("+1")).toBe(false);
  });

  it("an override of reactions false makes react unsupported", async () => {
    const transport = new MockTransport({ capabilities: { reactions: false } });
    const ref = refOf(await transport.send({ handle: "+1", text: "lunch?" }));

    const result = await transport.react({ to: ref, emoji: "👀" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "unsupported", capability: "reactions", message: "Mock channel has reactions off" },
    });
    expect(transport.log.map((event) => event.type)).toEqual(["send"]);
  });

  it("a failure scoped to react leaves the next send ok", async () => {
    const transport = new MockTransport();
    const ref = refOf(await transport.send({ handle: "+1", text: "lunch?" }));
    transport.failNext({ kind: "rate-limited", retryAfterSeconds: 3, message: "slow down" }, "react");

    const reacted = await transport.react({ to: ref, emoji: "👀" });
    const sent = await transport.send({ handle: "+1", text: "dinner?" });

    expect(reacted).toEqual({
      ok: false,
      error: { kind: "rate-limited", retryAfterSeconds: 3, message: "slow down" },
    });
    expect(sent.ok).toBe(true);
  });

  it("keeps the last reaction on a message and clears it on null", async () => {
    const transport = new MockTransport();
    const ref = refOf(await transport.send({ handle: "+1", text: "lunch?" }));

    await transport.react({ to: ref, emoji: "👀" });
    await transport.react({ to: ref, emoji: "✅" });
    expect(transport.messageAt(ref)?.reaction).toBe("✅");

    await transport.react({ to: ref, emoji: null });
    expect(transport.messageAt(ref)?.reaction).toBeUndefined();
  });

  it("an edit updates the stored message, and an identical one is unchanged", async () => {
    const transport = new MockTransport();
    const buttons = [[{ label: "Ate", data: "v1|ate" }]];
    const ref = refOf(await transport.send({ handle: "+1", text: "lunch?", buttons }));

    const first = await transport.edit({ ref, text: "Logged", buttons: "remove" });
    const repeat = await transport.edit({ ref, text: "Logged", buttons: "remove" });

    expect(first).toEqual({ ok: true, changed: true });
    expect(repeat).toEqual({ ok: true, changed: false });
    expect(transport.messageAt(ref)).toEqual({ text: "Logged" });
  });

  it("the mock rejects an empty edit the same way", async () => {
    const transport = new MockTransport();
    const ref = refOf(await transport.send({ handle: "+1", text: "lunch?" }));

    const result = await transport.edit({ ref });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "bad-buttons",
        message: "An edit needs text or buttons to change; this one had neither",
      },
    });
    expect(transport.log.map((event) => event.type)).toEqual(["send"]);
  });

  it("an unknown ref is message-gone", async () => {
    const transport = new MockTransport();

    const result = await transport.edit({
      ref: { channel: "mock", chat: "+1", messageId: "nope" },
      text: "hi",
    });

    expect(!result.ok && result.error.kind).toBe("message-gone");
  });

  it("logs every interaction with the time it happened", async () => {
    const clock = new ManualClock(500);
    const transport = new MockTransport({ now: () => clock.now() });
    const ref = refOf(await transport.send({ handle: "+1", text: "lunch?" }));

    await clock.advance(250);
    await transport.react({ to: ref, emoji: "👀" });
    await transport.answerAction({ actionId: "cbq-1", toast: "Logged" });

    expect(transport.log.map((event) => [event.type, event.at])).toEqual([
      ["send", 500],
      ["react", 750],
      ["answer", 750],
    ]);
  });

  it("still takes a bare clock function, as 0.3.0 consumers pass it", async () => {
    const transport = new MockTransport(() => 7);

    await transport.send({ handle: "+1", text: "one" });

    expect(transport.sent).toEqual([{ handle: "+1", text: "one", at: 7 }]);
  });
});

describe("ManualClock", () => {
  it("resolves a sleep only once its time has passed", async () => {
    const clock = new ManualClock(0);
    let woke = false;
    void clock.sleep(1000).then(() => (woke = true));

    await clock.advance(999);
    expect(woke).toBe(false);

    await clock.advance(1);
    expect(woke).toBe(true);
  });
});

describe("update builders", () => {
  it("a fake text update reads back through the real parser", () => {
    const read = readInbound(fakeTextUpdate({ messageId: 808, text: "ate it", threadId: 12 }));

    expect(read).toEqual({
      ok: true,
      inbound: {
        kind: "text",
        updateId: 1,
        chatId: 4242,
        fromId: 99,
        messageId: 808,
        text: "ate it",
        date: 1757808000,
        threadId: 12,
      },
    });
  });

  it("a fake tap carries back the buttons it was given", () => {
    const buttons = [[{ label: "Ate", data: "v1|ate" }]];

    const read = readInbound(fakeCallbackUpdate({ messageText: "Lunch?", buttons }));

    expect(read.ok && read.inbound).toMatchObject({
      kind: "callback",
      messageText: "Lunch?",
      buttons,
    });
  });
});
