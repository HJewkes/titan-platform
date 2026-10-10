import { describe, expect, it } from "vitest";
import type { HealthSample, HealthSampleInput } from "@titan-design/health";
import { sampleTick } from "./sample-tick.js";
import { measureSelf } from "./self-cost.js";
import type { HealthTarget } from "./targets.js";

const targets: HealthTarget[] = ["a", "b", "c"].map((name) => ({ name, url: `http://127.0.0.1/${name}`, timeoutMs: 100 }));

function probeAs(status: HealthSample["status"]) {
  return async (target: HealthTarget): Promise<HealthSample> => ({
    ts: "2026-10-09T08:00:00.000Z",
    target: target.name,
    kind: "http",
    status,
    source: "probe",
  });
}

describe("sampleTick", () => {
  it("writes every target plus one self row in a single append", async () => {
    const appends: HealthSampleInput[][] = [];

    await sampleTick(targets, { probe: probeAs("fail"), append: (rows) => (appends.push([...rows]), rows.length) });

    expect(appends).toHaveLength(1);
    expect(appends[0]?.map((r) => r.target)).toEqual(["a", "b", "c", "titan-health-sampler"]);
  });

  it("stores the tick whatever the targets answered", async () => {
    const appends: HealthSampleInput[][] = [];

    const written = await sampleTick(targets, { probe: probeAs("fail"), append: (rows) => (appends.push([...rows]), rows.length) });

    expect(written).toBe(4);
    expect(appends[0]?.slice(0, 3).map((r) => r.status)).toEqual(["fail", "fail", "fail"]);
  });

  it("gives the self row the sampler's own cost as non-negative numbers", async () => {
    const appends: HealthSampleInput[][] = [];

    await sampleTick(targets, { probe: probeAs("pass"), append: (rows) => (appends.push([...rows]), rows.length) });

    const self = appends[0]?.at(-1);
    expect(self).toMatchObject({ kind: "self", status: "pass", target: "titan-health-sampler" });
    const observed = self?.observed ?? {};
    for (const key of ["cpuUserUs", "cpuSystemUs", "fsReadBlocks", "fsWriteBlocks", "voluntaryCtx", "involuntaryCtx", "maxRssKb", "wallMs"]) {
      expect(observed[key], key).toBeTypeOf("number");
      expect(observed[key] as number, key).toBeGreaterThanOrEqual(0);
    }
    expect(observed.targets).toBe(3);
  });
});

describe("measureSelf", () => {
  it("copies process counters from start into the self row", () => {
    const row = measureSelf(2, {
      now: () => Date.parse("2026-10-09T08:00:01.000Z"),
      wallMs: () => 412.5,
      cpuUsage: () => ({ user: 120_000, system: 30_000 }),
      resourceUsage: () => ({ fsRead: 4, fsWrite: 16, voluntaryContextSwitches: 90, involuntaryContextSwitches: 7, maxRSS: 51_200 }),
    });

    expect(row).toEqual({
      ts: "2026-10-09T08:00:01.000Z",
      target: "titan-health-sampler",
      kind: "self",
      status: "pass",
      source: "probe",
      observed: {
        cpuUserUs: 120_000,
        cpuSystemUs: 30_000,
        fsReadBlocks: 4,
        fsWriteBlocks: 16,
        voluntaryCtx: 90,
        involuntaryCtx: 7,
        maxRssKb: 51_200,
        wallMs: 412.5,
        targets: 2,
      },
    });
  });
});
