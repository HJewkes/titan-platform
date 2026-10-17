import { describe, expect, it } from "vitest";
import { usageFromRolloutEvents, type UsageResult } from "../usage.js";
import { statuslineLine } from "./statusline.js";

const now = 1_800_000_000;
function reading(five = 12.9, weekly = 76.2, at = now - 12.75): UsageResult {
  return usageFromRolloutEvents([{ type: "event_msg", timestamp: new Date(at * 1000).toISOString(), payload: {
    type: "token_count", rate_limits: {
      primary: { used_percent: five, window_minutes: 300, resets_at: now + 2000 },
      secondary: { used_percent: weekly, window_minutes: 10080, resets_at: now + 3000 },
    },
  } }], "reporter");
}

describe("Codex statusline rendering", () => {
  it("prints the existing extra-account format with integer used percentages and age", () => {
    expect(statuslineLine("reporter", reading(), now)).toBe("codex|reporter|12|76|12|");
  });
  it("shows observed exhaustion rather than confusing admission refusal with missing quota", () => {
    expect(statuslineLine("reporter", reading(100, 99), now)).toBe("codex|reporter|100|99|12|");
  });
  it("preserves real zero readings", () => {
    expect(statuslineLine("reporter", reading(0, 0, now), now)).toBe("codex|reporter|0|0|0|");
  });
  it("checks freshness before rounding the display age", () => {
    expect(statuslineLine("reporter", reading(20, 30, now - 900), now)).toBe("codex|reporter|20|30|900|");
    expect(statuslineLine("reporter", reading(20, 30, now - 900.1), now)).toBe("codex|reporter|unknown|unknown||");
  });
  it.each(["missing", "inconsistent", "unreadable"] as const)("renders %s without guessed numbers", reason => {
    expect(statuslineLine("reporter", { status: "unknown", reason }, now)).toBe("codex|reporter|unknown|unknown||");
  });
  it("refuses future observations, invalid clocks and expired resets", () => {
    expect(statuslineLine("reporter", reading(20, 30, now + 1), now)).toContain("|unknown|unknown||");
    expect(statuslineLine("reporter", reading(), NaN)).toContain("|unknown|unknown||");
    expect(statuslineLine("reporter", reading(), now + 3000)).toContain("|unknown|unknown||");
  });
  it("rejects another account's reading instead of relabelling it", () => {
    expect(statuslineLine("other", reading(), now)).toBe("codex|other|unknown|unknown||");
  });
  it.each(["bad|label", "line\nbreak", "sk-proj-privateToken"])("does not echo an unsafe label", label => {
    expect(statuslineLine(label, reading(), now)).toBe("codex|default|unknown|unknown||");
  });
});
