import { describe, expect, it } from "vitest";
import { seatCost } from "./seats.js";

const rows = [
  { ts: "2026-03-10T10:00:00Z", outcome: "dispatched", usd_est: null },
  { ts: "2026-03-10T14:00:00Z", outcome: "dispatched", usd_est: null },
  { ts: "2026-03-10T15:00:00Z", outcome: "retired", usd_est: 1.25 },
  { ts: "2026-03-10T16:00:00Z", outcome: "merged", usd_est: 0.5 },
];

describe("seatCost", () => {
  it("counts spawns and sums dollars inside the window and skips a malformed line", () => {
    const jsonl = [...rows.map((row) => JSON.stringify(row)), "{not json"].join("\n");

    expect(seatCost("seat-a", jsonl, new Date("2026-03-10T12:00:00Z"))).toEqual({ seat: "seat-a", dispatches: 1, usd: 1.75 });
  });
});
