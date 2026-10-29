import { describe, expect, it } from "vitest";
import type { ReviewAsk } from "./review-queue.js";
import { admitSpawn, DEFAULT_SPAWN_LIMITS, spawnGate, type MachineReadings } from "./spawn-gate.js";

const limits = DEFAULT_SPAWN_LIMITS;
/** A 48-core host with 13 cores busy, as sampled on 2026-10-29. */
const sampled: MachineReadings = { load5: 13, load1: 13, cores: 48, pressureLevel: 1, freeMemoryPct: 60 };
const NOW = 1_000_000;

describe("admission reads measured headroom", () => {
  it("admits a review with ten more just started when the measured cores leave room", () => {
    const justStarted = Array.from({ length: 10 }, () => NOW - 1_000);

    expect(admitSpawn(sampled, limits, [], NOW, justStarted)).toEqual({ admit: true });
  });

  it("refuses when the busy cores leave fewer idle than the floor, naming the idle cores", () => {
    const saturated = { ...sampled, load5: 15, load1: 47.5 };

    expect(admitSpawn(saturated, limits, [], NOW)).toEqual({ admit: false, reason: "idle cores 0.5 with 0 unabsorbed reviews are under the floor 1" });
  });

  it("refuses once a configured floor is past what the measured cores leave", () => {
    expect(admitSpawn(sampled, { ...limits, minIdleCores: 40 }, [], NOW).admit).toBe(false);
  });

  it("leaves the idle-core floor unapplied when the core count is unread", () => {
    const unread = { load5: 2, load1: 60, pressureLevel: 1, freeMemoryPct: 60 };

    expect(admitSpawn(unread, limits, [], NOW)).toEqual({ admit: true });
  });
});

describe("the review queue's room comes from the measured cost, capped by the concurrent backstop", () => {
  const intent = (intentAt: number): ReviewAsk => ({ fixer: false, intentAt });

  function admittedOf(readings: MachineReadings, cap: number): string[] {
    const gate = spawnGate({ limits: { maxConcurrentReviews: cap }, read: () => readings, now: () => NOW, log: () => undefined });
    const names = Array.from({ length: 12 }, (_, index) => `rv-burst-${index}`);
    return names.filter((name, index) => {
      try {
        gate.admit(name, [], intent(10_000 + index));
        return true;
      } catch {
        return false;
      }
    });
  }

  it("admits reviews up to the configured cap on a host with idle cores", () => {
    expect(admittedOf(sampled, 8)).toHaveLength(8);
  });

  it("admits none on a host whose measured cores are all busy", () => {
    expect(admittedOf({ ...sampled, load1: 48 }, 8)).toEqual([]);
  });
});
