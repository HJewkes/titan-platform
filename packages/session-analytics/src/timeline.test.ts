import { describe, expect, it } from "vitest";
import { countAtOrBefore } from "./count-at-or-before.js";
import { CONVERSATION, SIDECHAIN, TEST_PRICES, TimelineFixture, midnightSession } from "./timeline-fixture.js";
import { SessionTimelineAccumulator, buildSessionTimeline } from "./timeline.js";
import { SESSION_TIMELINE_VERSION } from "./timeline-types.js";

const ms = (iso: string) => Date.parse(iso);
const MINUTE = 60_000;
const options = { prices: TEST_PRICES };

describe("a session that crosses midnight", () => {
  const timeline = buildSessionTimeline(midnightSession(), options);

  it("spans both days as one continuous session", () => {
    expect(timeline).toMatchObject({ version: SESSION_TIMELINE_VERSION, sessionId: CONVERSATION.nativeId, harness: "claude-code" });
    expect(timeline.startMs).toBe(ms("2026-03-01T23:58:10Z"));
    expect(timeline.endMs).toBe(ms("2026-03-02T00:15:00Z"));
    expect(timeline.durationMs).toBe(16 * MINUTE + 50_000);
  });

  it("keeps the minute buckets in order through midnight and counts each one", () => {
    expect(timeline.buckets.map((bucket) => new Date(bucket.minuteMs).toISOString().slice(0, 16))).toEqual([
      "2026-03-01T23:58",
      "2026-03-01T23:59",
      "2026-03-02T00:00",
      "2026-03-02T00:01",
      "2026-03-02T00:14",
      "2026-03-02T00:15",
    ]);
    expect(timeline.buckets[0]).toMatchObject({ events: 4, messages: 2, toolCalls: 1, errors: 0, outputTokens: 200_000, costUsd: 2 });
    expect(timeline.buckets[1]).toMatchObject({ events: 2, messages: 0, toolCalls: 1, errors: 1 });
    expect(timeline.buckets[5]).toMatchObject({ events: 1, messages: 0, toolCalls: 0 });
  });

  it("marks the one idle stretch of ten minutes or more and no gap at midnight", () => {
    expect(timeline.gaps).toEqual([{ startMs: ms("2026-03-02T00:01:05Z"), endMs: ms("2026-03-02T00:14:05Z"), durationMs: 13 * MINUTE }]);
    expect(timeline.buckets.map((bucket) => bucket.gapBeforeMs)).toEqual([null, null, null, null, 13 * MINUTE, null]);
    expect(timeline.turns.map((turn) => turn.gapBeforeMs)).toEqual([null, 13 * MINUTE]);
  });

  it("opens a turn at each user message and keeps what followed inside it", () => {
    const [first, second] = timeline.turns;
    expect(first).toMatchObject({ index: 0, origin: "prompt", startMs: ms("2026-03-01T23:58:10Z"), endMs: ms("2026-03-02T00:01:05Z"), errorCount: 1 });
    expect(first?.user?.text).toBe("run the build");
    expect(first?.assistant.map((message) => message.text)).toEqual(["Starting the build.", "The build passes."]);
    expect(first?.toolCalls.map((call) => call.id)).toEqual(["c1", "c2", "c3"]);
    expect(second?.toolCalls.map((call) => call.id)).toEqual(["c4"]);
  });

  it("orders a turn's messages and tool calls by seq", () => {
    const first = timeline.turns[0];
    const ordered = [...(first?.assistant ?? []), ...(first?.toolCalls ?? [])].sort((a, b) => a.seq - b.seq);
    expect(ordered.map((entry) => ("id" in entry ? entry.id : entry.text))).toEqual(["Starting the build.", "c1", "c2", "c3", "The build passes."]);
  });

  it("pairs each tool call with its result", () => {
    const calls = timeline.turns.flatMap((turn) => turn.toolCalls);
    expect(calls.map((call) => [call.id, call.outcome, call.durationMs])).toEqual([
      ["c1", "success", 30_000],
      ["c2", "error", 10_000],
      ["c3", "success", 5_000],
      ["c4", "success", 50_000],
    ]);
    expect(calls[1]).toMatchObject({ family: "fs_read", filePath: "/repo/src/app.ts", inputSummary: "/repo/src/app.ts", errorMessage: "File does not exist." });
    expect(calls[0]).toMatchObject({ family: "bash", filePath: null, inputSummary: "pnpm build", errorMessage: null });
  });

  it("prices each request and accumulates output and cost", () => {
    const { points } = timeline.tokens;
    expect(points.map((point) => point.costUsd)).toEqual([2, 0.1, 1, 0.5, 2, 0.1]);
    expect(points.map((point) => point.cumulativeOutputTokens)).toEqual([200_000, 200_000, 200_000, 300_000, 300_000, 300_000]);
    expect(points.at(-1)?.cumulativeCostUsd).toBeCloseTo(5.7);
    expect(points.map((point) => point.contextTokens)).toEqual([1_000_000, 1_000_000, 500_000, 0, 2_000_000, 100_000]);
    expect(timeline.tokens.basis).toBe("delta");
    expect(timeline.tokens.models).toEqual([{ model: "fixture-model", requests: 6 }]);
  });

  it("marks the compaction and the first request after it", () => {
    expect(timeline.tokens.compactions).toEqual([expect.objectContaining({ atMs: ms("2026-03-02T00:14:30Z"), turnIndex: 1, summary: null })]);
    expect(timeline.tokens.points.map((point) => point.afterCompaction)).toEqual([false, false, false, false, false, true]);
  });

  it("totals the session and splits tokens and cost by turn", () => {
    expect(timeline.totals).toMatchObject({ turns: 2, userMessages: 2, assistantMessages: 2, toolCalls: 4, errors: 1, compactions: 1, requests: 6, unpricedRequests: 0 });
    expect(timeline.totals.tokens).toEqual({ input: 3_100_000, cacheRead: 1_000_000, cacheWrite: 500_000, cacheWrite5m: 500_000, cacheWrite1h: 0, output: 300_000 });
    expect(timeline.totals.costUsd).toBeCloseTo(5.7);
    expect(timeline.turns[0]?.costUsd).toBeCloseTo(3.6);
    expect(timeline.turns[1]?.tokens).toEqual({ input: 2_100_000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
  });

  it("breaks tools down by name and family", () => {
    expect(timeline.tools.byName.map((row) => [row.name, row.calls, row.errors, row.durationMs])).toEqual([
      ["Agent", 1, 0, 50_000],
      ["Bash", 1, 0, 30_000],
      ["Edit", 1, 0, 5_000],
      ["Read", 1, 1, 10_000],
    ]);
    expect(timeline.tools.byFamily.find((row) => row.family === "fs_read")).toEqual({ family: "fs_read", calls: 1, errors: 1, atMs: [ms("2026-03-01T23:59:30Z")] });
  });

  it("lists each file once per kind of access, in order of first touch", () => {
    expect(timeline.files).toEqual({
      touches: [
        { path: "/repo/src/app.ts", access: "read", atMs: ms("2026-03-01T23:59:30Z"), calls: 1 },
        { path: "/repo/src/app.ts", access: "write", atMs: ms("2026-03-02T00:00:15Z"), calls: 1 },
      ],
      readCount: 1,
      writeCount: 1,
    });
  });

  it("lists errors at the time the failing result arrived", () => {
    expect(timeline.errors.rate).toBe(0.25);
    expect(timeline.errors.items).toEqual([
      { callId: "c2", toolName: "Read", turnIndex: 0, atMs: ms("2026-03-01T23:59:40Z"), message: "File does not exist.", sidechain: false },
    ]);
  });

  it("spans a subagent dispatch from its call to its result", () => {
    expect(timeline.agents).toEqual([
      { callId: "c4", label: "run the tests", startMs: ms("2026-03-02T00:14:10Z"), endMs: ms("2026-03-02T00:15:00Z"), outcome: "success" },
    ]);
  });

  it("answers how much had happened by a scrubbed time on either side of midnight", () => {
    expect(countAtOrBefore(timeline.tools.atMs, ms("2026-03-01T23:59:59Z"))).toBe(2);
    expect(countAtOrBefore(timeline.tools.atMs, ms("2026-03-02T00:00:15Z"))).toBe(3);
    expect(countAtOrBefore(timeline.errors.atMs, ms("2026-03-01T23:59:39Z"))).toBe(0);
    expect(countAtOrBefore(timeline.errors.atMs, ms("2026-03-02T00:10:00Z"))).toBe(1);
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(timeline))).toEqual(timeline);
  });
});

describe("time handling", () => {
  it("reads zone offsets as instants, so local midnight makes no gap", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([
      f.user("2026-03-01T23:59:30-07:00", "first"),
      f.assistant("2026-03-02T00:00:10-07:00", "second"),
    ]);

    expect(timeline.durationMs).toBe(40_000);
    expect(timeline.gaps).toEqual([]);
    expect((timeline.buckets[1]?.minuteMs ?? 0) - (timeline.buckets[0]?.minuteMs ?? 0)).toBe(MINUTE);
  });

  it("treats exactly ten idle minutes as a gap and one second less as none", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([
      f.user("2026-03-01T10:00:00Z", "first"),
      f.user("2026-03-01T10:09:59Z", "second"),
      f.user("2026-03-01T10:19:59Z", "third"),
    ]);

    expect(timeline.turns.map((turn) => turn.gapBeforeMs)).toEqual([null, null, 10 * MINUTE]);
    expect(timeline.gaps).toHaveLength(1);
  });

  it("does not call the wait on a long tool call a gap, unless the call never returned", () => {
    const f = new TimelineFixture();
    const returned = buildSessionTimeline([
      f.user("2026-03-01T10:00:00Z", "run the long job"),
      f.call("2026-03-01T10:00:05Z", "long", "Bash", { command: "make all" }),
      f.result("2026-03-01T10:25:05Z", "long", false),
    ]);
    const abandoned = buildSessionTimeline([
      f.user("2026-03-01T10:00:00Z", "run the long job"),
      f.call("2026-03-01T10:00:05Z", "lost", "Bash", { command: "make all" }),
      f.user("2026-03-01T10:25:05Z", "are you there"),
    ]);

    expect(returned.gaps).toEqual([]);
    expect(returned.buckets.map((bucket) => bucket.gapBeforeMs)).toEqual([null, null]);
    expect(abandoned.gaps).toEqual([expect.objectContaining({ durationMs: 25 * MINUTE })]);
  });

  it("honours a caller's gap threshold", () => {
    const f = new TimelineFixture();
    const observations = [f.user("2026-03-01T10:00:00Z", "first"), f.user("2026-03-01T10:02:00Z", "second")];

    expect(buildSessionTimeline(observations, { gapMinMs: 2 * MINUTE }).gaps).toHaveLength(1);
  });

  it("places a record with no timestamp at the latest time seen", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([f.user("2026-03-01T10:00:00Z", "first"), f.assistant(null, "second")]);

    expect(timeline.turns[0]?.assistant[0]?.atMs).toBe(ms("2026-03-01T10:00:00Z"));
  });

  it("returns an empty timeline for no observations", () => {
    const timeline = buildSessionTimeline([]);

    expect(timeline).toMatchObject({ sessionId: null, startMs: null, endMs: null, durationMs: 0, turns: [], buckets: [], gaps: [] });
    expect(timeline.tokens).toEqual({ basis: "unreported", points: [], compactions: [], models: [] });
    expect(timeline.errors.rate).toBe(0);
  });
});

describe("turns", () => {
  it("labels a harness-injected opener and a compaction summary apart from a prompt", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([
      f.user("2026-03-01T10:00:00Z", "<task-notification><task-id>t1</task-id></task-notification>"),
      f.user("2026-03-01T10:00:05Z", "This session is being continued from a previous conversation.\n\nEarlier work, summarised."),
      f.user("2026-03-01T10:00:09Z", "carry on"),
    ]);

    expect(timeline.turns.map((turn) => [turn.origin, turn.injectedMarker])).toEqual([
      ["injected", "task_notification"],
      ["compaction", "compaction_summary"],
      ["prompt", null],
    ]);
  });

  it("holds activity that precedes any user message in a turn with no opener", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([f.assistant("2026-03-01T10:00:00Z", "resuming")]);

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]).toMatchObject({ origin: "none", user: null });
    expect(timeline.totals.userMessages).toBe(0);
  });

  it("keeps a subagent's inlined messages out of the turns and flags its tool calls", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([
      f.user("2026-03-01T10:00:00Z", "delegate this"),
      f.user("2026-03-01T10:00:01Z", "subagent brief", SIDECHAIN),
      f.assistant("2026-03-01T10:00:02Z", "subagent reply", SIDECHAIN),
      f.call("2026-03-01T10:00:03Z", "s1", "Grep", { pattern: "needle" }, SIDECHAIN),
    ]);

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]?.assistant).toEqual([]);
    expect(timeline.turns[0]?.toolCalls[0]).toMatchObject({ id: "s1", sidechain: true, inputSummary: "needle" });
  });

  it("cuts long text at the cap and says so", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([f.user("2026-03-01T10:00:00Z", "x".repeat(50))], { maxTextChars: 20 });

    expect(timeline.turns[0]?.user).toMatchObject({ text: "x".repeat(20), truncated: true });
  });

  it("counts a message once when the source repeats its line", () => {
    const f = new TimelineFixture();
    const reply = f.assistant("2026-03-01T10:00:01Z", "once");
    const timeline = buildSessionTimeline([f.user("2026-03-01T10:00:00Z", "go"), reply, reply]);

    expect(timeline.totals.assistantMessages).toBe(1);
  });
});

describe("tool calls", () => {
  it("leaves a call with no result pending and an unreported error state unknown", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([
      f.user("2026-03-01T10:00:00Z", "go"),
      f.call("2026-03-01T10:00:01Z", "a", "Bash", { command: "sleep 600" }),
      f.call("2026-03-01T10:00:02Z", "b", "shell", { command: "ls" }),
      f.result("2026-03-01T10:00:03Z", "b", null),
    ]);

    expect(timeline.turns[0]?.toolCalls.map((call) => [call.id, call.outcome, call.endMs])).toEqual([
      ["a", "pending", null],
      ["b", "unknown", ms("2026-03-01T10:00:03Z")],
    ]);
    expect(timeline.totals.errors).toBe(0);
  });

  it("reads an error message out of a block list and drops a result with no call", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([
      f.user("2026-03-01T10:00:00Z", "go"),
      f.call("2026-03-01T10:00:01Z", "a", "Bash", { command: "exit 1\necho unreachable" }),
      f.result("2026-03-01T10:00:02Z", "a", true, [{ type: "text", text: "exit status 1" }]),
      f.result("2026-03-01T10:00:03Z", "never-called", true, "orphan"),
    ]);

    expect(timeline.errors.items.map((item) => item.message)).toEqual(["exit status 1"]);
    expect(timeline.turns[0]?.toolCalls[0]?.inputSummary).toBe("exit 1");
  });
});

describe("usage", () => {
  it("counts a response written over several lines once, at its first time with its last counts", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline(
      [
        f.user("2026-03-01T10:00:00Z", "go"),
        f.usage("2026-03-01T10:00:01Z", "r1", { input: 1_000_000, output: 0 }),
        f.usage("2026-03-01T10:00:02Z", "r1", { input: 1_000_000, output: 200_000 }),
      ],
      options,
    );

    expect(timeline.tokens.points).toHaveLength(1);
    expect(timeline.tokens.points[0]).toMatchObject({ atMs: ms("2026-03-01T10:00:01Z"), outputTokens: 200_000, costUsd: 2, turnIndex: 0 });
    expect(timeline.totals.requests).toBe(1);
  });

  it("leaves a model with no price row unpriced instead of guessing a rate", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([f.usage("2026-03-01T10:00:00Z", "r1", { input: 1_000_000, output: 1_000_000, model: "unlisted-model" })], options);

    expect(timeline.tokens.points[0]).toMatchObject({ priced: false, costUsd: 0 });
    expect(timeline.totals).toMatchObject({ unpricedRequests: 1, costUsd: 0 });
  });

  it("reports totals but no points for a source that only writes running totals", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([f.snapshot("2026-03-01T10:00:00Z", 1, 100, 10), f.snapshot("2026-03-01T10:00:05Z", 2, 300, 40)]);

    expect(timeline.tokens).toMatchObject({ basis: "snapshot", points: [] });
    expect(timeline.totals).toMatchObject({ requests: null, tokens: { input: 300, cacheRead: 0, cacheWrite: 0, output: 40 } });
  });

  it("joins a compaction's boundary and its summary into one mark at the boundary's time", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([f.compaction("2026-03-01T10:00:00Z"), f.compaction("2026-03-01T10:00:02Z", "earlier work")]);

    expect(timeline.totals.compactions).toBe(1);
    expect(timeline.tokens.compactions).toEqual([expect.objectContaining({ atMs: ms("2026-03-01T10:00:00Z"), byteOffset: 0, summary: "earlier work" })]);
  });

  it("keeps two compactions apart when a request ran between them or each has its own summary", () => {
    const f = new TimelineFixture();
    const withRequest = buildSessionTimeline([
      f.compaction("2026-03-01T10:00:00Z"),
      f.usage("2026-03-01T10:00:05Z", "r1", { input: 1, output: 1 }),
      f.compaction("2026-03-01T10:30:00Z", "second"),
    ]);
    const summariesOnly = buildSessionTimeline([f.compaction("2026-03-01T10:00:00Z", "first"), f.compaction("2026-03-01T10:30:00Z", "second")]);

    expect(withRequest.tokens.compactions.map((mark) => mark.summary)).toEqual([null, "second"]);
    expect(summariesOnly.tokens.compactions.map((mark) => mark.summary)).toEqual(["first", "second"]);
  });

  it("carries a compaction summary, capped", () => {
    const f = new TimelineFixture();
    const timeline = buildSessionTimeline([f.compaction("2026-03-01T10:00:00Z", "y".repeat(30))], { maxTextChars: 10 });

    expect(timeline.tokens.compactions[0]).toMatchObject({ summary: "y".repeat(10), summaryTruncated: true, turnIndex: null });
  });
});

describe("conversation boundaries", () => {
  it("leaves history copied from a parent conversation out", () => {
    const f = new TimelineFixture();
    const copied = { historyOrigin: { ...CONVERSATION, nativeId: "parent" } };
    const timeline = buildSessionTimeline([f.user("2026-03-01T09:00:00Z", "parent prompt", copied), f.user("2026-03-01T10:00:00Z", "own prompt")]);

    expect(timeline.turns.map((turn) => turn.user?.text)).toEqual(["own prompt"]);
    expect(timeline.startMs).toBe(ms("2026-03-01T10:00:00Z"));
  });

  it("refuses observations from two conversations", () => {
    const other = new TimelineFixture({ ...CONVERSATION, nativeId: "session-b" });
    const observations = [new TimelineFixture().user("2026-03-01T10:00:00Z", "one"), other.user("2026-03-01T10:00:01Z", "two")];

    expect(() => buildSessionTimeline(observations)).toThrow(/different conversations/);
  });
});

describe("SessionTimelineAccumulator", () => {
  it("hands out a copy that later observations and the caller's own edits cannot reach", () => {
    const f = new TimelineFixture();
    const accumulator = new SessionTimelineAccumulator();
    accumulator.add(f.user("2026-03-01T10:00:00Z", "go"));
    accumulator.add(f.call("2026-03-01T10:00:01Z", "a", "Bash", { command: "ls" }));

    const early = accumulator.result();
    early.turns.length = 0;
    accumulator.add(f.result("2026-03-01T10:00:02Z", "a", true, "failed"));
    const late = accumulator.result();

    expect(late.turns[0]?.toolCalls[0]?.outcome).toBe("error");
    expect(accumulator.result().turns).not.toBe(late.turns);
    expect(early.tools.byName[0]?.errors).toBe(0);
  });

  it("gives the same result each time it is asked", () => {
    const accumulator = new SessionTimelineAccumulator(options);
    for (const observation of midnightSession()) accumulator.add(observation);

    const first = structuredClone(accumulator.result());

    expect(accumulator.result()).toEqual(first);
    expect(first).toEqual(buildSessionTimeline(midnightSession(), options));
  });
});

describe("countAtOrBefore", () => {
  it("counts the entries at or before the target", () => {
    expect(countAtOrBefore([], 5)).toBe(0);
    expect(countAtOrBefore([1, 3, 3, 7], 0)).toBe(0);
    expect(countAtOrBefore([1, 3, 3, 7], 3)).toBe(3);
    expect(countAtOrBefore([1, 3, 3, 7], 100)).toBe(4);
  });
});
