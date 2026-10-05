import type { SourceTextLocator } from "@titan-design/session-read";
import { describe, expect, it } from "vitest";
import { awaitLateVerdict, awaitVerdict, parseAwaitVerdictInput, type AwaitVerdictTiming } from "./await-verdict.js";
import type { AwaitVerdictInput, ReviewerMessage, ReviewerReader } from "./review.js";
import type { Presence } from "./presence.js";

const MINUTE = 60_000;
const HEAD = "c".repeat(40);
const DISPATCHED_AT = 1_000_000;
const input: AwaitVerdictInput = { repo: "octo/demo", pr: 7, head: HEAD, reviewerAgentId: "reviewer-1", reviewerSessionId: "session-1", dispatchedAt: DISPATCHED_AT };
const locator = { source: { conversation: { nativeId: "session-1" } }, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } } as unknown as SourceTextLocator;
const verdictMessage = (writtenAt: number): ReviewerMessage => ({
  agentId: "reviewer-1",
  sessionId: "session-1",
  writtenAt,
  text: `Looked at it.\n\nVerdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\n`,
  locator,
});
const signal = new AbortController().signal;

/** A fake clock that a restarted step resumes at `minutesIn` after dispatch; each sleep advances it. */
function restartedAt(minutesIn: number) {
  let time = DISPATCHED_AT + minutesIn * MINUTE;
  const timing: AwaitVerdictTiming = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    pollMs: 10_000,
    timeoutMs: 30 * MINUTE,
    exitGraceMs: MINUTE,
    detachGraceMs: 10 * MINUTE,
  };
  return { timing, start: time, elapsed: () => time - DISPATCHED_AT - minutesIn * MINUTE };
}

const rosterOf = (presenceAt: () => Presence | "absent") => async () => {
  const presence = presenceAt();
  return presence === "absent" ? [] : [{ agentId: "reviewer-1", presence }];
};
const countingReader = (verdictFrom = Number.POSITIVE_INFINITY, now: () => number = () => 0) => {
  const reader = { reads: 0, read: async () => (reader.reads++, now() >= verdictFrom ? [verdictMessage(verdictFrom)] : []) };
  return reader satisfies ReviewerReader;
};

describe("awaitVerdict after a restart", () => {
  it("ends at once when the review was dispatched longer ago than the verdict timeout", async () => {
    const clock = restartedAt(31);
    const reader = countingReader();

    const result = await awaitVerdict(reader, input, clock.timing, signal, rosterOf(() => "live"));

    expect(result).toEqual({ kind: "none" });
    expect(reader.reads).toBe(1);
    expect(clock.elapsed()).toBe(0);
  });

  it("keeps only the time left since dispatch, not a fresh 30 minutes", async () => {
    const clock = restartedAt(25);

    const result = await awaitVerdict(countingReader(), input, clock.timing, signal, rosterOf(() => "live"));

    expect(result).toEqual({ kind: "none" });
    expect(clock.elapsed()).toBe(5 * MINUTE);
  });

  it.each([
    ["exited", "exited"],
    ["deregistered", "absent"],
  ] as const)("ends on the first read when the reviewer is already %s, past the exit grace since dispatch", async (_name, presence) => {
    const clock = restartedAt(2);
    const reader = countingReader();

    const result = await awaitVerdict(reader, input, clock.timing, signal, rosterOf(() => presence));

    expect(result).toEqual({ kind: "none" });
    expect(clock.elapsed()).toBe(0);
    expect(reader.reads).toBe(2);
  });

  it("still gives an exited reviewer its grace when the first read comes within the grace of dispatch", async () => {
    const clock = restartedAt(0);

    const result = await awaitVerdict(countingReader(), input, clock.timing, signal, rosterOf(() => "exited"));

    expect(result).toEqual({ kind: "none" });
    expect(clock.elapsed()).toBe(MINUTE);
  });

  it("keeps the exit grace for a reviewer that exits mid-wait, long after its start", async () => {
    const clock = restartedAt(20);
    const exitAt = clock.start + 2 * MINUTE;

    const result = await awaitVerdict(countingReader(), input, clock.timing, signal, rosterOf(() => (clock.timing.now() < exitAt ? "live" : "exited")));

    expect(result).toEqual({ kind: "none" });
    expect(clock.elapsed()).toBe(3 * MINUTE);
  });

  it("counts from the reviewer's session start, not the intent, when a busy broker held the start up", async () => {
    const clock = restartedAt(40);
    const startedAt = clock.start - 25 * MINUTE;

    const result = await awaitVerdict(countingReader(), { ...input, startedAt }, clock.timing, signal, rosterOf(() => "live"));

    expect(result).toEqual({ kind: "none" });
    expect(clock.elapsed()).toBe(5 * MINUTE);
  });

  it("gives a reviewer detached at restart the full detach grace from first sight, since a broker restart detaches everyone", async () => {
    const clock = restartedAt(15);

    const result = await awaitVerdict(countingReader(), input, clock.timing, signal, rosterOf(() => "detached"));

    expect(result).toEqual({ kind: "none" });
    expect(clock.elapsed()).toBe(10 * MINUTE);
  });

  it("takes the verdict a reviewer detached at restart writes once the broker is back", async () => {
    const clock = restartedAt(15);
    const back = clock.start + 3 * MINUTE;
    const reader = countingReader(back + MINUTE, clock.timing.now);

    const result = await awaitVerdict(reader, input, clock.timing, signal, rosterOf(() => (clock.timing.now() < back ? "detached" : "live")));

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
  });
});

describe("awaitLateVerdict after the dispatch-anchored wait ran out", () => {
  it("still reads the late verdict of a live reviewer", async () => {
    const clock = restartedAt(31);
    const reader = countingReader(clock.start + 2 * MINUTE, clock.timing.now);

    const result = await awaitLateVerdict(reader, async () => false, input, { ...clock.timing, timeoutMs: 10 * MINUTE }, signal);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE" });
  });
});

describe("parseAwaitVerdictInput startedAt", () => {
  it("keeps a finite startedAt", () => {
    expect(parseAwaitVerdictInput({ ...input, startedAt: DISPATCHED_AT + MINUTE })).toEqual({ ...input, startedAt: DISPATCHED_AT + MINUTE });
  });

  it.each([
    ["a string", "1000"],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["null", null],
  ])("rejects a startedAt that is %s", (_name, startedAt) => {
    expect(() => parseAwaitVerdictInput({ ...input, startedAt })).toThrow("sh-await-verdict: startedAt must be epoch milliseconds");
  });
});
