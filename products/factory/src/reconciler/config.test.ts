import { describe, expect, it } from "vitest";
import { FactoryConfigSchema } from "../config.js";
import { reconcilerConfig } from "./config.js";

const issues = (config: object) => {
  const parsed = FactoryConfigSchema.safeParse(config);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("reconciler config (I8)", () => {
  it("defaults to off, a 5 minute interval, a snapshot at least every 3 ticks and no repos", () => {
    expect(reconcilerConfig({})).toEqual({ enabled: false, intervalMs: 300_000, fullEvery: 3, repos: [] });
  });

  it("accepts 5 to 10 minutes under github.sources webhook and refuses either side of that", () => {
    const webhook = (intervalMs: number) => issues({ github: { sources: "webhook" }, reconciler: { intervalMs } });

    expect(webhook(300_000)).toEqual([]);
    expect(webhook(600_000)).toEqual([]);
    expect(webhook(299_999)).toEqual(["reconciler.intervalMs: intervalMs must be 300000-600000 under github.sources webhook"]);
    expect(webhook(600_001)).toEqual(["reconciler.intervalMs: intervalMs must be 300000-600000 under github.sources webhook"]);
  });

  it("leaves the polling-mode interval to TP-3099's bound", () => {
    expect(issues({ github: { sources: "polling" }, reconciler: { intervalMs: 60_000 } })).toEqual([]);
    expect(issues({ reconciler: { intervalMs: 60_000 } })).toEqual([]);
  });

  it("refuses an unknown key, a repo that is not owner/name and a fullEvery out of range", () => {
    expect(issues({ reconciler: { enable: true } })).not.toEqual([]);
    expect(issues({ reconciler: { repos: ["widgets"] } })).not.toEqual([]);
    expect(issues({ reconciler: { fullEvery: 0 } })).not.toEqual([]);
  });
});
