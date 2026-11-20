import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bet } from "../planning.js";
import { loadPlanRecords, recordPredictionChecks, writePlanRecord } from "./index.js";

const bet: Bet = {
  id: "alpha/B1",
  initiative: "alpha",
  week: "2026-W47",
  outcome: "alpha/faster-landing",
  order: 1,
  tasks: ["alpha/AL-1"],
  prediction: { metric: "reverts", direction: "decrease", baseline: 6, expected: 2, read_by: "2026-11-30" },
  state: "selected",
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pm-prediction-record-"));
  mkdirSync(path.join(root, "alpha"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("recordPredictionChecks", () => {
  it("stores missed on a bet whose week reads above expected", async () => {
    await writePlanRecord(root, "bet", bet);
    const rows = [{ isoWeek: "2026-W47", dimension: "initiative", key: "alpha", metrics: { reverts: 5 } }];

    await recordPredictionChecks(root, "alpha", rows);

    expect((await loadPlanRecords(root, "alpha", "bet"))[0]?.prediction_check).toBe("missed");
  });

  it("stores unread on a bet when no row matches", async () => {
    await writePlanRecord(root, "bet", bet);

    await recordPredictionChecks(root, "alpha", []);

    expect((await loadPlanRecords(root, "alpha", "bet"))[0]?.prediction_check).toBe("unread");
  });
});
