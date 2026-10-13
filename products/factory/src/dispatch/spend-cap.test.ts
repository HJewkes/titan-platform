import { describe, expect, it } from "vitest";
import { capVerdict, sumSpend, type TranscriptSpendRead } from "./spend-cap.js";

const ok = (usd: number | null, tokens = 1000, path = "/t/ok.jsonl"): TranscriptSpendRead => ({ ok: true, path, tokens, usd_est: usd });
const missing: TranscriptSpendRead = { ok: false, path: "/t/gone.jsonl" };

describe("sumSpend", () => {
  it("adds usd and tokens across the reads", () => {
    expect(sumSpend([ok(5.1, 100), ok(0.2, 50), ok(7.1, 25)])).toEqual({ usd: 12.4, tokens: 175, agents: 3, unknown: [] });
  });

  it("lists a not-ok read and a null-priced read as unknown", () => {
    const spend = sumSpend([ok(5), missing, ok(null, 10_000_000, "/t/unpriced.jsonl")]);

    expect(spend.usd).toBe(5);
    expect(spend.unknown).toEqual(["/t/gone.jsonl", "/t/unpriced.jsonl"]);
    expect(spend.agents).toBe(3);
  });
});

describe("capVerdict", () => {
  it("is over at a sum equal to the cap", () => {
    expect(capVerdict(sumSpend([ok(12)]), 12)).toBe("over");
  });

  it("is under one cent below the cap", () => {
    expect(capVerdict(sumSpend([ok(11.99)]), 12)).toBe("under");
  });

  it("is unknown when under the cap with an unknown read", () => {
    expect(capVerdict(sumSpend([ok(5), missing]), 12)).toBe("unknown");
  });

  it("is over when the known sum reaches the cap despite an unknown read", () => {
    expect(capVerdict(sumSpend([ok(13), missing]), 12)).toBe("over");
  });
});
