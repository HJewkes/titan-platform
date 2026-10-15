import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatCall } from "@titan-design/agent-dispatch";
import type { Logger } from "@titan-design/daemon";
import { logAgentChatCalls } from "./serve-agent-chat-timing.js";

const HOUR_MS = 3_600_000;

function fakeLog() {
  return { info: vi.fn<Logger["info"]>(), warn: vi.fn<Logger["warn"]>(), error: vi.fn<Logger["error"]>() };
}

function fakeObserve() {
  const state = { report: undefined as ((call: AgentChatCall) => void) | undefined, now: undefined as (() => number) | undefined, unobserved: false };
  const observe = (report: (call: AgentChatCall) => void, options: { now?: () => number }) => {
    state.report = report;
    state.now = options.now;
    return () => {
      state.unobserved = true;
      state.report = undefined;
    };
  };
  const feed = (verb: string, ms: number) => state.report?.({ verb, ms, outcome: "ok" });
  return { observe, feed, state };
}

describe("logAgentChatCalls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns once for a call over 5 s and not for one at exactly 5 s", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const { observe, feed } = fakeObserve();
    const timing = logAgentChatCalls({ log, observe });

    feed("agent ls", 5_000);
    feed("agent ls", 5_001);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ verb: "agent ls", ms: 5_001, outcome: "ok" }, "agent-chat call slow");
    timing.stop();
  });

  it("logs one hourly summary with a nearest-rank p95 and nothing for an empty hour", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const { observe, feed } = fakeObserve();
    const timing = logAgentChatCalls({ log, observe });

    for (let s = 1; s <= 20; s++) feed("agent spawn", s * 1_000);
    vi.advanceTimersByTime(HOUR_MS);
    vi.advanceTimersByTime(HOUR_MS);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { verb: "agent spawn", count: 20, over5s: 15, p95Ms: 19_000, maxMs: 20_000, windowMs: HOUR_MS },
      "agent-chat calls",
    );
    timing.stop();
  });

  it("summarizes each verb on its own line", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const { observe, feed } = fakeObserve();
    const timing = logAgentChatCalls({ log, observe });

    feed("agent ls", 300);
    feed("agent spawn", 2_000);
    vi.advanceTimersByTime(HOUR_MS);

    expect(log.info.mock.calls.map(([fields]) => fields)).toEqual([
      { verb: "agent ls", count: 1, over5s: 0, p95Ms: 300, maxMs: 300, windowMs: HOUR_MS },
      { verb: "agent spawn", count: 1, over5s: 0, p95Ms: 2_000, maxMs: 2_000, windowMs: HOUR_MS },
    ]);
    timing.stop();
  });

  it("logs nothing after stop, for a call or a window", () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const { observe, feed, state } = fakeObserve();
    const timing = logAgentChatCalls({ log, observe });

    feed("agent ls", 100);
    timing.stop();
    feed("agent ls", 9_000);
    vi.advanceTimersByTime(HOUR_MS);

    expect(state.unobserved).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("passes the injected clock to the observer", () => {
    const now = () => 42;
    const { observe, state } = fakeObserve();

    logAgentChatCalls({ log: fakeLog(), now, observe }).stop();

    expect(state.now).toBe(now);
  });
});
