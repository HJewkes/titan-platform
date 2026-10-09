import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@titan-design/store-sqlite";
import type { HealthSample, SampleStatus } from "./sample.js";
import { appendSamples, openHealthStore } from "./store.js";
import { MAX_UPTIME_SLOTS, foldUptime, uptime } from "./uptime.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000);
const DAY = 24 * 60;

function sample(minute: number, status: SampleStatus = "pass", offsetSeconds = 7): HealthSample {
  const ts = new Date(at(minute).getTime() + offsetSeconds * 1000).toISOString();
  return { ts, target: "factory", kind: "http", status, source: "probe" };
}

function everyMinute(minutes: number, skip: (minute: number) => boolean = () => false): HealthSample[] {
  return Array.from({ length: minutes }, (_, minute) => minute).filter((m) => !skip(m)).map((m) => sample(m));
}

describe("foldUptime", () => {
  it("counts a 10-minute gap as missing, never as up", () => {
    const samples = everyMinute(DAY, (m) => m >= 600 && m < 610);

    const report = foldUptime(samples, { from: at(0), to: at(DAY) });

    expect(report).toMatchObject({ slots: DAY, up: DAY - 10, down: 0, unknown: 0, missing: 10 });
    expect(report.upShareOfWindow).toBe((DAY - 10) / DAY);
    expect(report.upShareOfObserved).toBe(1);
    expect(report.gaps).toEqual([{ from: at(600).toISOString(), to: at(610).toISOString() }]);
  });

  it("keeps separate gaps apart and merges consecutive missing slots", () => {
    const samples = [sample(0), sample(3), sample(4)];

    const report = foldUptime(samples, { from: at(0), to: at(7) });

    expect(report.gaps).toEqual([
      { from: at(1).toISOString(), to: at(3).toISOString() },
      { from: at(5).toISOString(), to: at(7).toISOString() },
    ]);
  });

  it("counts a slot with a pass and a fail sample as down", () => {
    const samples = [sample(0, "pass", 1), sample(0, "fail", 30), sample(0, "pass", 50), sample(1, "warn")];

    const report = foldUptime(samples, { from: at(0), to: at(2) });

    expect(report).toMatchObject({ slots: 2, up: 1, down: 1, missing: 0 });
    expect(report.upShareOfObserved).toBe(0.5);
  });

  it("reports unknown slots as neither up nor down", () => {
    const samples = [sample(0, "unknown"), sample(1, "pass"), sample(2, "fail"), sample(3, "unknown"), sample(3, "warn")];

    const report = foldUptime(samples, { from: at(0), to: at(4) });

    expect(report).toMatchObject({ slots: 4, up: 1, down: 1, unknown: 2, missing: 0 });
    expect(report.upShareOfWindow).toBe(0.25);
  });

  it("reports an empty window with no shares rather than a made-up one", () => {
    const report = foldUptime([], { from: at(5), to: at(5) });

    expect(report).toEqual({
      slots: 0,
      up: 0,
      down: 0,
      unknown: 0,
      missing: 0,
      upShareOfWindow: null,
      upShareOfObserved: null,
      gaps: [],
    });
  });

  it("reports a window with no samples as all missing", () => {
    const report = foldUptime([], { from: at(0), to: at(60) });

    expect(report).toMatchObject({ slots: 60, up: 0, missing: 60, upShareOfWindow: 0, upShareOfObserved: null });
    expect(report.gaps).toEqual([{ from: at(0).toISOString(), to: at(60).toISOString() }]);
  });

  it("counts only whole epoch-aligned slots inside an unaligned window", () => {
    const from = new Date(at(0).getTime() + 30_000);
    const to = new Date(at(3).getTime() + 30_000);

    const report = foldUptime([sample(0), sample(1), sample(2), sample(3)], { from, to });

    expect(report).toMatchObject({ slots: 2, up: 2, missing: 0 });
  });

  it("honours a wider tick", () => {
    const samples = [sample(0), sample(2), sample(4, "fail")];

    const report = foldUptime(samples, { from: at(0), to: at(6), tickSeconds: 120 });

    expect(report).toMatchObject({ slots: 3, up: 2, down: 1, missing: 0 });
  });

  it.each([0, -60, 1e-6, 0.0015, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a tick of %s seconds instead of hanging",
    (tickSeconds) => {
      expect(() => foldUptime([sample(0)], { from: at(0), to: at(2), tickSeconds })).toThrow(RangeError);
    },
  );

  it("accepts a whole-millisecond tick", () => {
    const report = foldUptime([], { from: at(0), to: new Date(T0 + 5), tickSeconds: 0.001 });

    expect(report).toMatchObject({ slots: 5, missing: 5 });
  });

  it.each([
    ["from", { from: new Date("bad"), to: at(2) }],
    ["to", { from: at(0), to: new Date("bad") }],
  ])("refuses an invalid %s date instead of reporting NaN slots", (_name, window) => {
    expect(() => foldUptime([], window)).toThrow(RangeError);
  });

  it("refuses a window wider than MAX_UPTIME_SLOTS", () => {
    const to = new Date(T0 + (MAX_UPTIME_SLOTS + 1) * 1000);

    expect(() => foldUptime([], { from: at(0), to, tickSeconds: 1 })).toThrow(RangeError);
  });
});

describe("uptime", () => {
  let db: Db;
  beforeEach(() => {
    db = openHealthStore(":memory:");
  });
  afterEach(() => db.close());

  it("folds the stored samples of one target", () => {
    appendSamples(db, [sample(0), sample(1, "fail"), { ...sample(2), target: "relay" }, sample(3)]);

    const report = uptime(db, "factory", at(0), at(4));

    expect(report).toMatchObject({ slots: 4, up: 2, down: 1, missing: 1 });
  });

  it("refuses a zero tick instead of hanging", () => {
    expect(() => uptime(db, "factory", at(0), at(4), { tickSeconds: 0 })).toThrow(RangeError);
  });
});
