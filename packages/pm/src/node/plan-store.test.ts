import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bet } from "../planning.js";
import { PlanStoreError, loadPlanRecords, nextPlanId, readPlanRecord, withPlanLock, writePlanRecord } from "./index.js";

const bet: Bet = {
  id: "alpha/B1",
  initiative: "alpha",
  week: "2026-W47",
  outcome: "alpha/faster-landing",
  order: 1,
  tasks: ["alpha/AL-1"],
  prediction: { metric: "median_review_to_merge_hours", direction: "decrease", baseline: 30, expected: 12, read_by: "2026-11-30" },
  state: "proposed",
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pm-plan-store-"));
  mkdirSync(path.join(root, "alpha"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the plan store", () => {
  it("writes a record to the file its id names and reads it back", async () => {
    await writePlanRecord(root, "bet", bet);

    expect(readFileSync(path.join(root, "alpha/plan/bets/B1.yml"), "utf8")).toContain("week: 2026-W47");
    expect(await readPlanRecord(root, "bet", "alpha/B1")).toEqual(bet);
    expect(await loadPlanRecords(root, "alpha", "bet")).toEqual([bet]);
  });

  it("reads a missing record or a malformed id as null, and a missing folder as no records", async () => {
    expect(await readPlanRecord(root, "bet", "alpha/B9")).toBeNull();
    expect(await readPlanRecord(root, "bet", "../B1")).toBeNull();
    expect(await loadPlanRecords(root, "alpha", "outcome")).toEqual([]);
  });

  it("refuses an invalid record before anything reaches disk", async () => {
    const bad: Bet = { ...bet, week: "next week" };

    await expect(writePlanRecord(root, "bet", bad)).rejects.toMatchObject({ kind: "invalid" });
    expect(await loadPlanRecords(root, "alpha", "bet")).toEqual([]);
  });

  it("throws on a stored file that fails its schema rather than skipping it", async () => {
    mkdirSync(path.join(root, "alpha/plan/bets"), { recursive: true });
    writeFileSync(path.join(root, "alpha/plan/bets/B2.yml"), "id: alpha/B2\n");

    await expect(readPlanRecord(root, "bet", "alpha/B2")).rejects.toThrow(/Schema validation failed/);
  });

  it("numbers the next id one above the highest in use", () => {
    expect(nextPlanId("alpha", "B", [{ id: "alpha/B1" }, { id: "alpha/B7" }])).toBe("alpha/B8");
    expect(nextPlanId("alpha", "F", [])).toBe("alpha/F1");
  });
});

describe("the plan lock", () => {
  it("refuses an initiative that does not exist as not-found", async () => {
    const run = withPlanLock(root, "beta", async () => "ran");

    await expect(run).rejects.toBeInstanceOf(PlanStoreError);
    await expect(run).rejects.toMatchObject({ kind: "not-found", message: "Initiative not found: beta" });
  });

  it("runs one holder at a time on the same initiative", async () => {
    const order: string[] = [];
    const hold = (name: string) =>
      withPlanLock(root, "alpha", async () => {
        order.push(`${name}:in`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`${name}:out`);
      });

    await Promise.all([hold("a"), hold("b")]);

    expect([order.slice(0, 2), order.slice(2)].map((pair) => pair[0]!.split(":")[0] === pair[1]!.split(":")[0])).toEqual([true, true]);
  });
});
