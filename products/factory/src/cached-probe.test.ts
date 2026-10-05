import { describe, expect, it, vi } from "vitest";
import { cachedProbe } from "./cached-probe.js";

describe("cachedProbe", () => {
  it("answers pending, then the probe result once it lands", async () => {
    const probe = cachedProbe(async () => 7, { now: () => 0, ttlMs: 10, pending: "checking" });

    expect(probe.status()).toBe("checking");
    await probe.refresh();

    expect(probe.status()).toBe(7);
  });

  it("keeps a falsy result instead of falling back to pending", async () => {
    const probe = cachedProbe(async () => 0, { now: () => 0, ttlMs: 10, pending: "checking" });

    await probe.refresh();

    expect(probe.status()).toBe(0);
  });

  it("dedupes concurrent refreshes and reprobes once the ttl passes", async () => {
    let clock = 0;
    const run = vi.fn(async () => "ok");
    const probe = cachedProbe(run, { now: () => clock, ttlMs: 10, pending: "checking" });

    await Promise.all([probe.refresh(), probe.refresh()]);
    clock = 9;
    await probe.refresh();
    expect(run).toHaveBeenCalledTimes(1);

    clock = 10;
    await probe.refresh();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
