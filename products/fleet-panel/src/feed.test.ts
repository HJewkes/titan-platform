import { afterEach, describe, expect, it, vi } from "vitest";
import { Feed, ReconcileSchedule, type FeedSources } from "./feed.js";
import { ACCOUNTS_JSON, NOW_MS, ROSTER_JSON, STATUS_LINES, fixtureBook } from "./fixture.js";
import { parseAccounts, parseRoster, parseStatusLine } from "./inputs.js";
import type { Snapshot } from "./snapshot.js";

function sources(overrides: Partial<FeedSources> = {}): FeedSources {
  return {
    roster: async () => parseRoster(ROSTER_JSON),
    accounts: async () => parseAccounts(ACCOUNTS_JSON),
    slots: async () => ({ held: 3, cap: 12 }),
    statusLine: async (entry) => {
      const text = STATUS_LINES[entry.sessionId];
      return text === undefined ? null : parseStatusLine(text);
    },
    ...overrides,
  };
}

function feedWith(source: FeedSources, now: () => number, streamError: string | null = null) {
  const emitted: Snapshot[] = [];
  const feed = new Feed({ sources: source, book: fixtureBook(), emit: (s) => emitted.push(s), now, streamError: () => streamError });
  return { feed, emitted };
}

describe("Feed", () => {
  it("emits a snapshot joining every source", async () => {
    const { feed, emitted } = feedWith(sources(), () => NOW_MS);

    await feed.reconcile();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.agents.find((a) => a.name === "builder-a")?.cost?.usd).toBe(4.1);
    expect(emitted[0]?.errors).toEqual([]);
  });

  it("keeps the last roster when a read fails, and says how old it is", async () => {
    let now = NOW_MS;
    let fail = false;
    const roster = async () => {
      if (fail) throw new Error("broker not running\nstack");
      return parseRoster(ROSTER_JSON);
    };
    const { feed, emitted } = feedWith(sources({ roster }), () => now);
    await feed.reconcile();
    fail = true;
    now += 45_000;

    await feed.reconcile();

    expect(emitted[1]?.agents).toHaveLength(emitted[0]?.agents.length ?? -1);
    expect(emitted[1]?.errors).toEqual(["roster: broker not running (showing the read from 45s ago)"]);
  });

  it("reports an unreachable broker and a broken event stream without failing the snapshot", async () => {
    const slots = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { feed, emitted } = feedWith(sources({ slots }), () => NOW_MS, "the broker closed the event stream");

    await feed.reconcile();

    expect(emitted[0]?.slots).toBeNull();
    expect(emitted[0]?.errors).toEqual(["broker health: connect ECONNREFUSED", "events: the broker closed the event stream"]);
  });
});

describe("ReconcileSchedule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function scheduled(reconcile: () => Promise<unknown>) {
    vi.useFakeTimers();
    return new ReconcileSchedule(reconcile, {
      pollMs: 15_000,
      minGapMs: 1_000,
      now: () => Date.now(),
      timers: { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle) },
    });
  }

  it("polls on its interval", async () => {
    const reconcile = vi.fn(async () => undefined);
    const schedule = scheduled(reconcile);

    schedule.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(reconcile).toHaveBeenCalledTimes(3);
    schedule.stop();
  });

  it("answers a burst of pushed events with one reconcile, no sooner than the minimum gap", async () => {
    const reconcile = vi.fn(async () => undefined);
    const schedule = scheduled(reconcile);
    schedule.start();
    await vi.advanceTimersByTimeAsync(100);

    for (let i = 0; i < 5; i++) schedule.poke();
    await vi.advanceTimersByTimeAsync(800);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);

    expect(reconcile).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it("runs once more after a reconcile that a push arrived during", async () => {
    let finish: () => void = () => {};
    const reconcile = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const schedule = scheduled(reconcile);
    schedule.start();

    schedule.poke();
    finish();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconcile).toHaveBeenCalledTimes(2);
    schedule.stop();
  });
});
