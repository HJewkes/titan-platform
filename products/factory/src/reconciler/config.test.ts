import { describe, expect, it } from "vitest";
import { FactoryConfigSchema } from "../config.js";
import { DEPRECATED_INTERVAL, reconcilerConfig, reconcilerDeprecations } from "./config.js";

const issues = (config: object) => {
  const parsed = FactoryConfigSchema.safeParse(config);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("reconciler config (I8)", () => {
  it("defaults to off, a snapshot at least every 3 ticks and no repos, with no interval of its own", () => {
    expect(reconcilerConfig({})).toEqual({ enabled: false, fullEvery: 3, repos: [] });
    expect(reconcilerDeprecations(reconcilerConfig({}))).toEqual([]);
  });

  it("loads a webhook config that still sets reconciler.intervalMs out of the backstop's range, and names it deprecated", () => {
    const config = { github: { sources: "webhook" }, reconciler: { intervalMs: 900_000 } };

    expect(issues(config)).toEqual([]);
    expect(reconcilerDeprecations(reconcilerConfig(config))).toEqual([DEPRECATED_INTERVAL]);
    expect(DEPRECATED_INTERVAL).toBe("config.deprecated reconciler.intervalMs ignored; use github.backstopIntervalMs");
  });

  it("leaves the webhook cadence's bound to github.backstopIntervalMs", () => {
    expect(issues({ github: { sources: "webhook", backstopIntervalMs: 900_000 } })).not.toEqual([]);
  });

  it("refuses an unknown key, a repo that is not owner/name and a fullEvery out of range", () => {
    expect(issues({ reconciler: { enable: true } })).not.toEqual([]);
    expect(issues({ reconciler: { repos: ["widgets"] } })).not.toEqual([]);
    expect(issues({ reconciler: { fullEvery: 0 } })).not.toEqual([]);
  });
});
