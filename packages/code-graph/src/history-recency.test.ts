import { describe, expect, it } from "vitest";
import type { ChurnWindow } from "./history/index.js";
import { computeRecencyWindows, windowSuffix } from "./history-recency.js";
import type { GraphMetric } from "./types.js";

const DAY = 86400;

const valueOf = (metrics: GraphMetric[], id: string, name: string) =>
  metrics.find((m) => m.nodeId === id && m.name === name)?.value;

describe("computeRecencyWindows for one window", () => {
  const now = 1_000_000 * DAY;
  const single = (seen: Map<string, number>, id: string) =>
    computeRecencyWindows(seen, new Map([[30, new Set([id])]]), now);

  it("discounts a file younger than the window proportionally", () => {
    const m = single(new Map([["new.ts", now - 6 * DAY]]), "new.ts");
    expect(valueOf(m, "new.ts", "recency_30d")).toBeCloseTo(0.2, 5);
    expect(valueOf(m, "new.ts", "file_age_days")).toBe(6);
  });

  it("does not discount a file older than the window (recency = 1)", () => {
    const m = single(new Map([["old.ts", now - 200 * DAY]]), "old.ts");
    expect(valueOf(m, "old.ts", "recency_30d")).toBe(1);
    expect(valueOf(m, "old.ts", "file_age_days")).toBe(200);
  });

  it("emits recency=1 (no age) for a churned file with an unknown first-seen date", () => {
    const m = single(new Map(), "ghost.ts");
    expect(valueOf(m, "ghost.ts", "recency_30d")).toBe(1);
    expect(valueOf(m, "ghost.ts", "file_age_days")).toBeUndefined();
  });
});

describe("windowSuffix", () => {
  it("maps a day count to `<n>d` and lifetime to `lifetime`", () => {
    expect(windowSuffix(30)).toBe("30d");
    expect(windowSuffix(180)).toBe("180d");
    expect(windowSuffix("lifetime")).toBe("lifetime");
  });
});

describe("computeRecencyWindows", () => {
  const now = 1000 * DAY;

  it("discounts a file younger than a window, leaves older windows at 1, and emits age once", () => {
    const byWindow = new Map<number, ReadonlySet<string>>([
      [30, new Set(["f.ts"])],
      [90, new Set(["f.ts"])],
      [180, new Set(["f.ts"])],
    ]);
    const m = computeRecencyWindows(new Map([["f.ts", now - 45 * DAY]]), byWindow, now);
    expect(valueOf(m, "f.ts", "recency_30d")).toBe(1);
    expect(valueOf(m, "f.ts", "recency_90d")).toBe(0.5);
    expect(valueOf(m, "f.ts", "recency_180d")).toBe(0.25);
    expect(m.filter((x) => x.name === "file_age_days")).toHaveLength(1);
    expect(valueOf(m, "f.ts", "file_age_days")).toBe(45);
  });

  it("defaults recency to 1 (no age discount) when first-seen is unknown", () => {
    const m = computeRecencyWindows(new Map(), new Map([[30, new Set(["ghost.ts"])]]), now);
    expect(valueOf(m, "ghost.ts", "recency_30d")).toBe(1);
    expect(m.some((x) => x.name === "file_age_days")).toBe(false);
  });

  it("never age-discounts the lifetime window even for a brand-new file", () => {
    const byWindow = new Map<ChurnWindow, ReadonlySet<string>>([["lifetime", new Set(["fresh.ts"])]]);
    const m = computeRecencyWindows(new Map([["fresh.ts", now - 1 * DAY]]), byWindow, now);
    expect(valueOf(m, "fresh.ts", "recency_lifetime")).toBe(1);
    expect(valueOf(m, "fresh.ts", "file_age_days")).toBe(1);
  });
});
