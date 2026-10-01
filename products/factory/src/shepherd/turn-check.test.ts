import type { AgentRow } from "@titan-design/agent-dispatch";
import { describe, expect, it } from "vitest";
import { awaitTurn, transcriptTurnSince } from "./turn-check.js";

const SINCE = Date.parse("2026-10-01T18:11:00.000Z");

const row = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  ...{ name: "impl-a", agentId: "id-impl-a", state: "live", presence: "live", status: "running", profile: "implementer", surface: "iterm", model: null, cwd: "/work/impl-a" },
  ...{ sessionId: "s-impl-a", transcriptPath: "/transcripts/impl-a.jsonl", transcriptExists: true, spawnedBy: null, account: null, generation: 1, teleportFrom: null },
  ...overrides,
});

describe("transcriptTurnSince", () => {
  const lastEventAt = (offsetMs: number) => async () => ({ lastEventAt: SINCE + offsetMs, fill: 10_000 });

  it.each([
    ["an event after the ask", 1, true],
    ["its last event at the ask itself", 0, false],
    ["its last event before the ask", -60_000, false],
  ])("reads a transcript with %s as turn started: %s", async (_case, offset, started) => {
    expect(await transcriptTurnSince(lastEventAt(offset))(row(), SINCE)).toBe(started);
  });

  it("shows no turn for a row whose transcript does not exist yet, without reading it", async () => {
    const read = async () => {
      throw new Error("read a missing transcript");
    };

    expect(await transcriptTurnSince(read)(row({ transcriptExists: false }), SINCE)).toBe(false);
  });
});

describe("awaitTurn", () => {
  function watch(turnAfterPolls: number, timeoutMs = 300_000) {
    let now = SINCE;
    let polls = 0;
    const result = {
      now: () => now,
      sleep: async (ms: number) => void (now += ms),
      pollMs: 30_000,
      timeoutMs,
      row: async () => row(),
      prMovedOn: async () => false,
      turnSince: async () => ++polls > turnAfterPolls,
    };
    return { watch: result, elapsed: () => now - SINCE };
  }

  it("is true at the first poll that shows a turn", async () => {
    const { watch: w, elapsed } = watch(2);

    expect(await awaitTurn(w, SINCE, new AbortController().signal)).toBe(true);
    expect(elapsed()).toBe(60_000);
  });

  it("is false once the 5 minutes pass with no turn", async () => {
    const { watch: w, elapsed } = watch(Number.POSITIVE_INFINITY);

    expect(await awaitTurn(w, SINCE, new AbortController().signal)).toBe(false);
    expect(elapsed()).toBe(300_000);
  });

  it("counts a read that throws as no turn yet", async () => {
    const { watch: w } = watch(0, 60_000);

    expect(await awaitTurn({ ...w, turnSince: async () => Promise.reject(new Error("transcript locked")) }, SINCE, new AbortController().signal)).toBe(false);
  });
});
