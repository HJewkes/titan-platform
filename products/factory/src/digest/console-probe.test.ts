import { describe, expect, it, vi } from "vitest";
import { fakeSources, NOW, SLOT } from "../test-support/digest.js";
import type { FrictionDay } from "../shepherd/owner-friction.js";
import { alarmLinks } from "./console-probe.js";
import { buildDigest } from "./run.js";

const ORIGIN = "https://console.example.ts.net";

const friction = (medianHours: number): FrictionDay => ({ day: "2026-03-10", ownerTouches: 1, kinds: [{ kind: "approve-merge", gates: 4, medianHours, maxHours: medianHours }] });

describe("alarmLinks", () => {
  it("keeps an origin whose root answers 401, probing it once", async () => {
    const urls: string[] = [];

    const links = await alarmLinks(ORIGIN, async (url) => (urls.push(url), 401));

    expect(links).toEqual({ origin: ORIGIN });
    expect(urls).toEqual([`${ORIGIN}/`]);
  });

  it("omits links when the origin answers 502", async () => {
    const links = await alarmLinks(ORIGIN, async () => 502);

    expect(links).toEqual({ gap: "digest.consoleOrigin https://console.example.ts.net answered 502, expected 200 or 401: alarm links omitted" });
  });

  it("omits links when the origin does not answer over https", async () => {
    const links = await alarmLinks(ORIGIN, async () => {
      throw new Error("connect ECONNREFUSED");
    });

    expect(links).toMatchObject({ gap: expect.stringContaining("did not answer over https (connect ECONNREFUSED)") });
  });
});

describe("buildDigest", () => {
  it("a console that answers 502 leaves the alarm without links and says why under gaps", async () => {
    const built = await buildDigest({ sources: fakeSources({ friction: () => friction(98) }), now: NOW, slot: SLOT, windowMinutes: 360, full: false, consoleOrigin: ORIGIN, probe: async () => 502 });

    expect(built.markdown).toContain("- digest.consoleOrigin https://console.example.ts.net answered 502,");
    expect(built.markdown).not.toContain("consoleOrigin unset");
    expect(built.alarmNote).toBeDefined();
  });

  it("a digest whose alarm does not fire never probes", async () => {
    const probe = vi.fn(async () => 200);

    await buildDigest({ sources: fakeSources(), now: NOW, slot: SLOT, windowMinutes: 360, full: false, consoleOrigin: ORIGIN, probe });

    expect(probe).not.toHaveBeenCalled();
  });
});
