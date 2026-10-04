import { describe, expect, it } from "vitest";
import { formatNumber, rankText } from "./format.js";

describe("rankText", () => {
  it("names which way is worse instead of calling rank 1 the best or the worst", () => {
    expect(rankText({ siblingRank: 1, siblingCount: 43, direction: "higher-worse" })).toBe("1st largest of 43; larger is worse");
    expect(rankText({ siblingRank: 1, siblingCount: 43, direction: "lower-worse" })).toBe("1st largest of 43; larger is better");
    expect(rankText({ siblingRank: 12, siblingCount: 43, direction: "neutral" })).toBe("12th largest of 43");
    expect(rankText({ siblingRank: null, siblingCount: 43, direction: "neutral" })).toBe("not ranked");
  });
});

describe("formatNumber", () => {
  it("groups integers, keeps two decimals, and says n/a for no value", () => {
    expect(formatNumber(57531)).toBe("57,531");
    expect(formatNumber(3.9166)).toBe("3.92");
    expect(formatNumber(null)).toBe("n/a");
  });
});
