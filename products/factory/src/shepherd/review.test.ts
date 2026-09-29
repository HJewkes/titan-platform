import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import type { ShepherdDeps } from "./phases.js";
import {
  acceptVerdict,
  awaitVerdict,
  parseAwaitVerdictInput,
  reviewRoutes,
  type AwaitVerdictInput,
  type ReviewerMessage,
  type ReviewerReader,
  type ReviewWiring,
} from "./review.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const input: AwaitVerdictInput = {
  repo: "octo/demo",
  pr: 7,
  head: HEAD,
  reviewerAgentId: "reviewer-1",
  reviewerSessionId: "session-1",
  dispatchedAt: 1_000,
};
const locatorIn = (nativeId: string) =>
  ({ source: { conversation: { nativeId } }, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } }) as unknown as SourceTextLocator;
const locator = locatorIn("session-1");

const block = (overrides: { verdict?: string; pr?: string; head?: string } = {}) =>
  `Looked at it.\n\nVerdict: ${overrides.verdict ?? "MERGE"}\nPR: ${overrides.pr ?? "octo/demo#7"}\nHead: ${overrides.head ?? HEAD}\n`;

const message = (overrides: Partial<ReviewerMessage> = {}): ReviewerMessage => ({
  agentId: "reviewer-1",
  sessionId: "session-1",
  writtenAt: 2_000,
  text: block(),
  locator,
  ...overrides,
});

describe("acceptVerdict", () => {
  it("accepts the final message of the dispatched agent and session, and keeps its locator, not its text", () => {
    const result = acceptVerdict(input, [message()]);

    expect(result).toEqual({ kind: "verdict", verdict: "MERGE", head: HEAD, locator });
    expect(JSON.stringify(result)).not.toContain("Looked at it");
  });

  it("carries a FIX_FIRST verdict", () => {
    expect(acceptVerdict(input, [message({ text: block({ verdict: "FIX_FIRST" }) })])).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST" });
  });

  it("refuses a message from another agent id in the same session", () => {
    expect(acceptVerdict(input, [message({ agentId: "reviewer-2" })])).toEqual({ kind: "none" });
  });

  it("refuses a message from the right agent id in another session", () => {
    expect(acceptVerdict(input, [message({ sessionId: "session-2" })])).toEqual({ kind: "none" });
  });

  it("refuses a block whose head differs from the requested head", () => {
    expect(acceptVerdict(input, [message({ text: block({ head: OTHER_HEAD }) })])).toEqual({ kind: "none" });
  });

  it("refuses a message written before dispatch", () => {
    expect(acceptVerdict(input, [message({ writtenAt: 999 })])).toEqual({ kind: "none" });
  });

  it("refuses a writtenAt that is a numeric string rather than a number", () => {
    expect(acceptVerdict(input, [message({ writtenAt: "3000" as unknown as number })])).toEqual({ kind: "none" });
  });

  it("refuses a message whose locator points into another session", () => {
    expect(acceptVerdict(input, [message({ locator: locatorIn("session-2") })])).toEqual({ kind: "none" });
  });

  it("refuses a message whose locator names no session", () => {
    expect(acceptVerdict(input, [message({ locator: { selector: locator.selector } as unknown as SourceTextLocator })])).toEqual({ kind: "none" });
  });

  it("refuses a message written at the dispatch instant", () => {
    expect(acceptVerdict(input, [message({ writtenAt: 1_000 })])).toEqual({ kind: "none" });
  });

  it("refuses a block for another PR number", () => {
    expect(acceptVerdict(input, [message({ text: block({ pr: "octo/demo#8" }) })])).toEqual({ kind: "none" });
  });

  it("refuses a block for another repository", () => {
    expect(acceptVerdict(input, [message({ text: block({ pr: "octo/other#7" }) })])).toEqual({ kind: "none" });
  });

  it("refuses a valid block that is not the final message", () => {
    const later = message({ writtenAt: 3_000, text: "One more thought, no verdict here." });

    expect(acceptVerdict(input, [message(), later])).toEqual({ kind: "none" });
  });

  it("refuses when the final message has no parseable block", () => {
    expect(acceptVerdict(input, [message({ text: "Verdict: maybe" })])).toEqual({ kind: "none" });
  });

  it("refuses when there are no messages", () => {
    expect(acceptVerdict(input, [])).toEqual({ kind: "none" });
  });
});

describe("awaitVerdict", () => {
  const clockAt = (start: number) => {
    let time = start;
    const sleeps: number[] = [];
    return {
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
      sleeps,
    };
  };
  const signal = new AbortController().signal;

  it("returns the verdict once the block appears in a later poll", async () => {
    const clock = clockAt(0);
    let reads = 0;
    const reader: ReviewerReader = { read: async () => (++reads < 3 ? [] : [message()]) };

    const result = await awaitVerdict(reader, input, { ...clock, pollMs: 100, timeoutMs: 10_000 }, signal);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
    expect(reads).toBe(3);
  });

  it("returns none at the deadline without an extra poll", async () => {
    const clock = clockAt(0);
    let reads = 0;
    const reader: ReviewerReader = { read: async () => (reads++, []) };

    const result = await awaitVerdict(reader, input, { ...clock, pollMs: 100, timeoutMs: 250 }, signal);

    expect(result).toEqual({ kind: "none" });
    expect(reads).toBe(4);
    expect(clock.now()).toBe(300);
  });

  it("treats a failing read as nothing yet", async () => {
    const clock = clockAt(0);
    const reader: ReviewerReader = { read: async () => Promise.reject(new Error("io")) };

    await expect(awaitVerdict(reader, input, { ...clock, pollMs: 100, timeoutMs: 150 }, signal)).resolves.toEqual({ kind: "none" });
  });
});

describe("parseAwaitVerdictInput", () => {
  it("accepts a complete input", () => {
    expect(parseAwaitVerdictInput({ ...input })).toEqual(input);
  });

  it.each([
    ["a missing reviewer session", { reviewerSessionId: "" }],
    ["a short head", { head: "abc" }],
    ["an uppercase head", { head: "A".repeat(40) }],
    ["a fractional pr", { pr: 1.5 }],
    ["a non-numeric dispatchedAt", { dispatchedAt: "1000" }],
  ])("throws on %s", (_name, patch) => {
    expect(() => parseAwaitVerdictInput({ ...input, ...patch })).toThrow(/sh-await-verdict/);
  });
});

describe("reviewRoutes", () => {
  const deps = { now: () => 5_000, sleep: async () => {}, pollMs: 10 } as unknown as ShepherdDeps;
  const run = async (wiring?: ReviewWiring) => {
    const route = reviewRoutes(deps, wiring)[0]!;
    const step = { prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 1, requestKey: "k", stepId: "sh-await-verdict" };
    return route.runner.run(step as never);
  };

  it("answers none without polling when no reader is wired", async () => {
    const outcome = await run();

    expect(outcome.ok && JSON.parse(outcome.output).result).toEqual({ kind: "none" });
  });

  it("records the locator of an accepted verdict when a reader is wired", async () => {
    const outcome = await run({ reader: { read: async () => [message()] } });

    expect(outcome.ok && JSON.parse(outcome.output).result).toMatchObject({ kind: "verdict", verdict: "MERGE", head: HEAD, locator });
  });
});
