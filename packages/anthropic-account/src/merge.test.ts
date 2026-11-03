import { describe, expect, it } from "vitest";
import { mergeAccountReadings, type ObservedReading } from "./merge.js";

const NOW_S = 2_000_000;
const NOW_MS = NOW_S * 1000;
const HOUR_S = 3600;
const FIVE_HOUR_RESET = NOW_S + HOUR_S;
const SEVEN_DAY_RESET = NOW_S + 3 * 86_400;

type Windows = Record<string, { used_percentage: number; resets_at?: number }>;

const status = (id: string, ageSeconds: number, rate_limits: Windows, extra = {}): ObservedReading => ({
  session_id: id,
  written_at: NOW_S - ageSeconds,
  rate_limits,
  ...extra,
});

const fiveHour = (pct: number, resets_at = FIVE_HOUR_RESET) => ({ used_percentage: pct, resets_at });
const sevenDay = (pct: number, resets_at = SEVEN_DAY_RESET) => ({ used_percentage: pct, resets_at });

const merge = (...readings: ObservedReading[]) =>
  mergeAccountReadings({ account: "acct-a", config_dirs: ["dir-a"], readings }, NOW_MS);

describe("account budget window merge", () => {
  it("reads both windows when a newer status line has only seven_day and the poller has both", () => {
    const got = merge(status("usage-poller", 120, { five_hour: fiveHour(20), seven_day: sevenDay(40) }), status("seat-a", 10, { seven_day: sevenDay(41) }));

    expect(got).toMatchObject({ age_seconds: 120, windows: { five_hour: { used_pct: 20 }, seven_day: { used_pct: 41, resets_at: SEVEN_DAY_RESET } } });
  });

  it("takes each window from the freshest file that has it", () => {
    const got = merge(status("usage-poller", 300, { five_hour: fiveHour(20), seven_day: sevenDay(40) }), status("a", 60, { five_hour: fiveHour(25) }), status("b", 5, { seven_day: sevenDay(42) }));

    expect(got).toMatchObject({ age_seconds: 60, windows: { five_hour: { used_pct: 25 }, seven_day: { used_pct: 42 } } });
  });

  it("borrows no window from a stale file", () => {
    const got = merge(status("usage-poller", 1_800, { five_hour: fiveHour(20), seven_day: sevenDay(40) }), status("seat-a", 10, { seven_day: sevenDay(41) }));

    expect(got).toMatchObject({ age_seconds: 10, windows: { seven_day: { used_pct: 41, resets_at: SEVEN_DAY_RESET } } });
    expect(got.windows).not.toHaveProperty("five_hour");
  });

  it("borrows no window whose reset has passed", () => {
    const got = merge(status("usage-poller", 120, { five_hour: fiveHour(80, NOW_S - 60), seven_day: sevenDay(40) }), status("seat-a", 10, { seven_day: sevenDay(41) }));

    expect(got.windows).not.toHaveProperty("five_hour");
  });

  it("a newer status line repeating a lower seven_day does not lower the poller's", () => {
    const got = merge(status("usage-poll", 90, { five_hour: fiveHour(4), seven_day: sevenDay(93) }), status("basement", 10, { seven_day: sevenDay(74) }));

    expect(got).toMatchObject({ source: "oauth-usage", age_seconds: 90, windows: { seven_day: { used_pct: 93 }, five_hour: { used_pct: 4 } } });
  });

  it("a reset reads as the new window", () => {
    const got = merge(status("usage-poller", 120, { seven_day: sevenDay(90, NOW_S - 60) }), status("a", 10, { seven_day: sevenDay(2, NOW_S + 7 * 86_400) }));

    expect(got.windows.seven_day?.used_pct).toBe(2);
  });

  it("a later window outranks a higher figure in an earlier one", () => {
    const got = merge(status("usage-poller", 120, { seven_day: sevenDay(90, NOW_S + 600) }), status("a", 10, { seven_day: sevenDay(2, NOW_S + 7 * 86_400) }));

    expect(got).toMatchObject({ age_seconds: 10, windows: { seven_day: { used_pct: 2 } } });
  });

  it("a resets_at that moved under an hour is the same window", () => {
    const got = merge(status("usage-poll", 90, { seven_day: sevenDay(93) }), status("a", 10, { seven_day: sevenDay(74, SEVEN_DAY_RESET + 1_800) }));

    expect(got.windows.seven_day?.used_pct).toBe(93);
  });

  it("a passed reset in the same hour cannot raise a window", () => {
    const got = merge(status("usage-poller", 120, { seven_day: sevenDay(90, NOW_S - 60) }), status("a", 10, { seven_day: sevenDay(50, NOW_S + 600) }));

    expect(got).toMatchObject({ age_seconds: 10, windows: { seven_day: { used_pct: 50 } } });
  });

  it("a stale lender cannot raise a window", () => {
    const got = merge(status("usage-poll", 1_800, { seven_day: sevenDay(99) }), status("a", 10, { seven_day: sevenDay(41) }));

    expect(got).toMatchObject({ source: "status-line", age_seconds: 10, windows: { seven_day: { used_pct: 41 } } });
  });
});

/** An idle session restamping a figure from its last API response, 35 h ago. */
const redrawingStale = () =>
  status("d7508c83", 10, { seven_day: sevenDay(74) }, { prompt_cache: { ttl: "1h", expires_at: NOW_S - 34 * HOUR_S } });
const poller = (ageS: number) => status("usage-poll", ageS, { five_hour: fiveHour(9), seven_day: sevenDay(95) });

describe("an account read is as old as its rate_limits, not its last redraw", () => {
  it("a session redrawing 35 h old rate_limits reads as 35 h old", () => {
    expect(merge(redrawingStale())).toMatchObject({ age_seconds: 35 * HOUR_S, stale: true });
  });

  it("a live session reads as fresh", () => {
    const live = status("live", 10, { seven_day: sevenDay(40) }, { prompt_cache: { ttl: "1h", expires_at: NOW_S + HOUR_S - 10 } });

    expect(merge(live)).toMatchObject({ age_seconds: 10, stale: false });
  });

  it("a 5m ttl is honoured", () => {
    const short = status("short", 10, { seven_day: sevenDay(40) }, { prompt_cache: { ttl: "5m", expires_at: NOW_S - 60 } });

    expect(merge(short).age_seconds).toBe(360);
  });

  it("a file without prompt_cache ages by written_at", () => {
    expect(merge(poller(117)).age_seconds).toBe(117);
  });

  it("a fresh poller beats a redrawing stale session", () => {
    const got = merge(redrawingStale(), poller(117));

    expect(got).toMatchObject({ source: "oauth-usage", age_seconds: 117, stale: false });
    expect(got.windows).toEqual({ five_hour: { used_pct: 9, resets_at: FIVE_HOUR_RESET }, seven_day: { used_pct: 95, resets_at: SEVEN_DAY_RESET } });
  });

  it("with every file stale, the youngest is returned and marked stale", () => {
    const got = merge(redrawingStale(), poller(20 * 60));

    expect(got).toMatchObject({ age_seconds: 1200, stale: true, windows: { seven_day: { used_pct: 95 } } });
  });
});

describe("the merge policy (usage-reader S3)", () => {
  it("a reading with no five_hour reports no open five_hour window", () => {
    const got = merge(status("usage-poll", 30, { seven_day: sevenDay(21) }));

    expect(got).toMatchObject({ source: "oauth-usage", stale: false, windows: { seven_day: { used_pct: 21 } } });
    expect(got.windows).not.toHaveProperty("five_hour");
  });

  it("a window whose every reset has passed reads as rolled to 0", () => {
    const got = merge(status("usage-poll", 30, { five_hour: fiveHour(80, NOW_S - 60), seven_day: sevenDay(40) }));

    expect(got.windows.five_hour).toEqual({ used_pct: 0, rolled: true });
    expect(got.windows.seven_day).toEqual({ used_pct: 40, resets_at: SEVEN_DAY_RESET });
  });

  it("the fresh poller stays the reading of record, raised by a higher status line in its window only", () => {
    const lender = { five_hour: fiveHour(60, FIVE_HOUR_RESET + 3 * HOUR_S), seven_day: sevenDay(55, SEVEN_DAY_RESET - 600) };
    const got = merge(status("usage-poll", 300, { five_hour: fiveHour(10), seven_day: sevenDay(40) }), status("a", 5, lender));

    expect(got).toMatchObject({ source: "oauth-usage", age_seconds: 300, stale: false });
    expect(got.windows).toEqual({ five_hour: { used_pct: 10, resets_at: FIVE_HOUR_RESET }, seven_day: { used_pct: 55, resets_at: SEVEN_DAY_RESET - 600 } });
  });

  it("a poller past 360 s is no longer the reading of record", () => {
    const got = merge(status("usage-poll", 400, { seven_day: sevenDay(40) }), status("a", 5, { seven_day: sevenDay(30, SEVEN_DAY_RESET + 4 * 86_400) }));

    expect(got).toMatchObject({ source: "status-line", age_seconds: 5, windows: { seven_day: { used_pct: 30 } } });
  });

  it("no readings give an empty row that carries the account", () => {
    const got = mergeAccountReadings({ account: "acct-a", config_dirs: ["dir-d"], identity: "id-1", auth_fail: true, readings: [] }, NOW_MS);

    expect(got).toEqual({ account: "acct-a", config_dirs: ["dir-d"], identity: "id-1", auth_fail: true, source: null, windows: {}, age_seconds: null, stale: false });
  });
});
