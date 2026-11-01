import { describe, expect, it } from "vitest";
import { dayStartFrom, dayUsage, dayWindow, perDayGuard, type PoolReading } from "./coord-day.js";

const local = (month: number, day: number, hour: number, minute = 0): number => new Date(2031, month - 1, day, hour, minute).getTime();
const reading = (ts: number, sevenDay: number, resetsAt: number): PoolReading => ({ ts, sevenDay, resetsAt });

describe("coordinator day window", () => {
  it("runs from the previous 07:00 when it is 06:30, not from the calendar date", () => {
    const window = dayWindow(local(10, 30, 6, 30), "07:00");

    expect(window).toEqual({ date: "2031-10-29", from: local(10, 29, 7), to: local(10, 30, 7) });
  });

  it("runs from today's 07:00 once it has passed", () => {
    expect(dayWindow(local(10, 30, 7, 1), "07:00")).toEqual({ date: "2031-10-30", from: local(10, 30, 7), to: local(10, 31, 7) });
  });

  it("names a given date's own window whatever the clock says", () => {
    expect(dayWindow(local(11, 5, 12), "06:15", "2031-10-20")).toEqual({ date: "2031-10-20", from: local(10, 20, 6, 15), to: local(10, 21, 6, 15) });
  });
});

describe("day start setting", () => {
  it("defaults to 07:00 and refuses a value that is not HH:MM", () => {
    expect(dayStartFrom(undefined)).toBe("07:00");
    expect(dayStartFrom("")).toBe("07:00");
    expect(dayStartFrom("06:30")).toBe("06:30");
    expect(() => dayStartFrom("7am")).toThrow(/TITAN_CONSOLE_DAY_START/);
    expect(() => dayStartFrom("25:00")).toThrow(/TITAN_CONSOLE_DAY_START/);
  });
});

describe("pool usage in the day", () => {
  const window = dayWindow(local(10, 30, 12), "07:00");
  const resetsAt = local(11, 3, 9);

  it("takes beforeToday from the last reading at or before the day's start", () => {
    const rows = [reading(local(10, 29, 20), 22, resetsAt), reading(local(10, 30, 6, 50), 30, resetsAt), reading(local(10, 30, 7, 5), 33, resetsAt)];

    const usage = dayUsage(rows, 41, window, resetsAt);

    expect(usage).toEqual({ beforeToday: 30, today: 11 });
    expect(perDayGuard(usage.beforeToday, 20)).toBe(50);
  });

  it("counts none of the old window once the seven-day window reset after the day's start", () => {
    const resetToday = local(10, 30, 9) + 7 * 86_400_000;
    const rows = [reading(local(10, 30, 6, 50), 88, local(10, 30, 9))];

    expect(dayUsage(rows, 4, window, resetToday)).toEqual({ beforeToday: 0, today: 4 });
  });

  it("skips readings of a rolled window and has no guard without a per-day limit", () => {
    const rows = [{ ...reading(local(10, 30, 6, 50), 0, resetsAt), rolled: true as const }, reading(local(10, 29, 12), 17, resetsAt)];

    expect(dayUsage(rows, 20, window, resetsAt)).toEqual({ beforeToday: 17, today: 3 });
    expect(perDayGuard(17, null)).toBeNull();
  });
});
