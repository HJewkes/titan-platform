import { describe, expect, it } from "vitest";
import { parseArgs, renderReport } from "./prefix-report.mjs";

describe("prefix-report", () => {
  it("renders the divergence table and the headline numbers", () => {
    const reuse = {
      sessions: 3,
      measured: 2,
      tokenShare: 0.307,
      medianShare: 0.35,
      medianFirstCallTokens: 23400,
      atLeast60: 1,
      atLeast70: 0,
      inputUsd: 12.5,
      hit: { hits: 2, total: 3, rate: 2 / 3 },
      divergence: { pairs: 4, identical: 1, byBlock: [{ path: "system[2]", pairs: 3, medianAbsoluteByte: 18963 }] },
      cacheControl: [{ signature: "system[1]:1h:global", sessions: 3 }],
    };

    const text = renderReport(reuse, { days: 7, windowMin: 60 });

    expect(text).toContain("token-weighted cache-read share: 30.7%; median share 35.0%");
    expect(text).toContain("median first-call tokens: 23,400");
    expect(text).toContain("| `system[2]` | 3 | 18,963 |");
    expect(text).toContain("| system[1]:1h:global | 3 |");
  });

  it("reads flags and refuses unknown ones", () => {
    expect(parseArgs(["--days", "3", "--window-min", "30"])).toEqual({ days: 3, pairs: 200, windowMin: 30 });
    expect(() => parseArgs(["--bogus", "1"])).toThrow(/usage/);
  });
});
