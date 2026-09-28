import { describe, expect, it } from "vitest";
import { MockTransport } from "./mock.js";

describe("MockTransport", () => {
  it("records every send in order", async () => {
    let clock = 100;
    const transport = new MockTransport(() => (clock += 10));

    await transport.send({ handle: "+15550000000", text: "one" });
    await transport.send({ handle: "+15550000000", text: "two" });

    expect(transport.sent).toEqual([
      { handle: "+15550000000", text: "one", at: 110 },
      { handle: "+15550000000", text: "two", at: 120 },
    ]);
  });

  it("records the buttons a send carried", async () => {
    const transport = new MockTransport(() => 7);
    const buttons = [[{ label: "Ate", data: "v1|ate|lunch|2026-09-18" }]];

    await transport.send({ handle: "+1", text: "lunch?", buttons });

    expect(transport.sent).toEqual([{ handle: "+1", text: "lunch?", buttons, at: 7 }]);
  });

  it("plays scripted failures in order, then succeeds", async () => {
    const transport = new MockTransport();
    transport.failNext({ kind: "unreachable", message: "coach session is dark" });
    transport.failNext({ kind: "rejected", status: 400, message: "nope" });

    const first = await transport.send({ handle: "+1", text: "a" });
    const second = await transport.send({ handle: "+1", text: "b" });
    const third = await transport.send({ handle: "+1", text: "c" });

    expect(first).toEqual({
      ok: false,
      error: { kind: "unreachable", message: "coach session is dark" },
    });
    expect(second).toEqual({
      ok: false,
      error: { kind: "rejected", status: 400, message: "nope" },
    });
    expect(third).toEqual({
      ok: true,
      messageGuid: "mock-3",
      ref: { channel: "mock", chat: "+1", messageId: "mock-3" },
    });
  });

  it("records an attempt that was scripted to fail", async () => {
    const transport = new MockTransport();
    transport.failNext({ kind: "unauthorized", message: "bad password" });

    await transport.send({ handle: "+1", text: "retry me" });

    expect(transport.sent.map((s) => s.text)).toEqual(["retry me"]);
  });

  it("plays a scripted indeterminate send so a consumer can test it does not resend", async () => {
    const transport = new MockTransport();
    transport.failNext({ kind: "indeterminate", message: "reset after write" });

    const result = await transport.send({ handle: "+1", text: "coach nudge" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "indeterminate", message: "reset after write" },
    });
    expect(transport.sent.map((s) => s.text)).toEqual(["coach nudge"]);
  });

  it("clears sends and scripted failures on reset", async () => {
    const transport = new MockTransport();
    transport.failNext({ kind: "unknown", message: "x" });
    await transport.send({ handle: "+1", text: "a" });

    transport.reset();
    const after = await transport.send({ handle: "+1", text: "b" });

    expect(transport.sent).toHaveLength(1);
    expect(after).toEqual({
      ok: true,
      messageGuid: "mock-1",
      ref: { channel: "mock", chat: "+1", messageId: "mock-1" },
    });
  });
});
