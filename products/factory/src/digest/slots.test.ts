import { describe, expect, it } from "vitest";
import { currentSlot, DEFAULT_SLOTS } from "./slots.js";

const TZ = "America/Denver";

describe("currentSlot", () => {
  it("picks the latest slot at or before now and runs the window back to the previous slot", () => {
    expect(currentSlot(new Date("2026-03-10T19:30:00Z"), TZ, DEFAULT_SLOTS)).toEqual({ slot: { date: "2026-03-10", hour: "12" }, windowMinutes: 90 + 360 });
  });

  it("before the first slot of the day reports the previous day's last slot", () => {
    expect(currentSlot(new Date("2026-03-10T09:00:00Z"), TZ, DEFAULT_SLOTS)).toEqual({ slot: { date: "2026-03-09", hour: "18" }, windowMinutes: 540 + 360 });
  });

  it("windows the first slot of the day back to the previous evening", () => {
    expect(currentSlot(new Date("2026-03-10T12:05:00Z"), TZ, DEFAULT_SLOTS)).toEqual({ slot: { date: "2026-03-10", hour: "06" }, windowMinutes: 5 + 720 });
  });

  it("gives a single daily slot a 24-hour window", () => {
    expect(currentSlot(new Date("2026-03-10T12:00:00Z"), TZ, [6]).windowMinutes).toBe(1440);
  });
});
