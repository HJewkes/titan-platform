import { describe, expect, it, vi } from "vitest";
import { quotaAdmission } from "../../dist/index.js";
import { readNativeUsage, type ReadNativeUsageOptions } from "../../dist/node.js";

const now = 1_800_000_000;
const profile = { codeHome: "/fixture/home", label: "fixture" };
function fixture(five = 20) {
  const bucket = { limitId: "codex", primary: { usedPercent: five, windowDurationMins: 300, resetsAt: now + 1000 },
    secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: now + 2000 } };
  const close = vi.fn(); const dispose = vi.fn(async () => {});
  const options: ReadNativeUsageOptions = {
    expectedAccountId: "fixture-account", env: {}, now: () => now, monotonicNow: () => 100,
    createWorkspace: async () => ({ cwd: "/fixture/empty", dispose }),
    resolveExecutable: async () => "/fixture/codex", inspectVersion: async () => "codex-cli 0.162.1",
    connect: () => ({ close, initialized: () => {}, request: async method => {
      if (method === "initialize") return { codexHome: profile.codeHome, userAgent: "codex_cli_rs/0.162.1" };
      if (method === "account/read") return { account: { type: "chatgpt" } };
      return { accountId: "fixture-account", ordinaryUsageAllowed: true, rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } };
    } }),
  };
  return { bucket, options, close, dispose };
}

describe("built public native/root observation integration", () => {
  it("admits a genuine built node observation through the canonical built root", async () => {
    const f = fixture(); const result = await readNativeUsage(profile, f.options);
    expect(result.status).toBe("known");
    expect(quotaAdmission(result, now + 3)).toEqual({ allowed: true, ageSeconds: 3 });
    expect(f.close).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the native five-hour snapshot at 100 after caller and returned-window mutation", async () => {
    const f = fixture(100); const result = await readNativeUsage(profile, f.options);
    if (result.status !== "known") throw new Error("fixture not known");
    f.bucket.primary.usedPercent = 0;
    expect(Object.isFrozen(f.bucket.primary)).toBe(false);
    expect(f.bucket.primary.usedPercent).toBe(0);
    const changed = Reflect.set(result.reading.rate_limits.five_hour, "used_percentage", 0);
    expect(quotaAdmission(result, now)).toEqual({ allowed: false, reason: "five-hour-ceiling", ageSeconds: 0 });
    expect(result.reading.rate_limits.five_hour.used_percentage).toBe(100);
    expect(changed).toBe(false);
  });

  it("refuses plain, reflected and serialized readings across the built entry boundary", async () => {
    const f = fixture(); const result = await readNativeUsage(profile, f.options);
    if (result.status !== "known") throw new Error("fixture not known");
    const reflected = { ...result.reading };
    for (const key of Object.getOwnPropertySymbols(result.reading)) {
      const descriptor = Object.getOwnPropertyDescriptor(result.reading, key);
      if (descriptor) Object.defineProperty(reflected, key, descriptor);
    }
    for (const reading of [{ ...result.reading }, reflected]) {
      expect(quotaAdmission({ status: "known", reading }, now)).toEqual({ allowed: false, reason: "inconsistent" });
    }
    const decoded: unknown = JSON.parse(JSON.stringify(result));
    // @ts-expect-error transport data has no factory-established observation identity
    expect(quotaAdmission(decoded, now)).toEqual({ allowed: false, reason: "inconsistent" });
  });

  it.each(["primary", "secondary"])("refuses an absent optional native %s window without inventing zero", async missing => {
    const f = fixture(); Reflect.deleteProperty(f.bucket, missing);
    const result = await readNativeUsage(profile, f.options);
    expect(result.status).toBe("unknown");
    expect(quotaAdmission(result, now).allowed).toBe(false);
  });
});
