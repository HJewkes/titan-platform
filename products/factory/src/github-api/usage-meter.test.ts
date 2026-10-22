import { describe, expect, it } from "vitest";
import { logPeaks, logUsage, usageMeter } from "./usage-meter.js";

const R1 = 1_790_000_000;
const R2 = R1 + 3600;

function rate(used: number, reset: number, resource = "core", limit = 5000): Headers {
  return new Headers({ "x-ratelimit-used": String(used), "x-ratelimit-limit": String(limit), "x-ratelimit-reset": String(reset), "x-ratelimit-resource": resource });
}

function capture(): { lines: Array<{ message: string; fields: Record<string, unknown> }>; log: { info: (fields: Record<string, unknown>, message: string) => void; warn: () => void; error: () => void } } {
  const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
  return { lines, log: { info: (fields, message) => lines.push({ message, fields }), warn: () => undefined, error: () => undefined } };
}

describe("usageMeter", () => {
  it("reports the pre-reset max for a window, not the last value it saw", () => {
    const meter = usageMeter();

    meter.observe(rate(1200, R1));
    meter.observe(rate(3100, R1));
    meter.observe(rate(40, R2));

    expect(meter.takePeaks()).toEqual([
      { resource: "core", used: 3100, limit: 5000, reset: R1 },
      { resource: "core", used: 40, limit: 5000, reset: R2 },
    ]);
  });

  it("keeps a window's max when a slower concurrent answer arrives later with a lower used", () => {
    const meter = usageMeter();

    meter.observe(rate(3100, R1));
    meter.observe(rate(2900, R1));

    expect(meter.takePeaks()).toEqual([{ resource: "core", used: 3100, limit: 5000, reset: R1 }]);
  });

  it("keeps core and graphql apart and reports each resource's latest window as current", () => {
    const meter = usageMeter();

    meter.observe(rate(900, R1, "core"));
    meter.observe(rate(70, R1, "graphql"));
    meter.observe(rate(500, R1, "core"));

    expect(meter.current()).toEqual([
      { resource: "core", used: 900, limit: 5000, reset: R1 },
      { resource: "graphql", used: 70, limit: 5000, reset: R1 },
    ]);
  });

  it("does not let a late answer from an older window replace the current one", () => {
    const meter = usageMeter();

    meter.observe(rate(10, R2));
    meter.observe(rate(4800, R1));

    expect(meter.current()).toEqual([{ resource: "core", used: 10, limit: 5000, reset: R2 }]);
  });

  it("carries a window's max into the next take while that window is still open", () => {
    const meter = usageMeter();
    meter.observe(rate(2500, R1));
    meter.takePeaks();

    meter.observe(rate(100, R1));

    expect(meter.takePeaks()).toEqual([{ resource: "core", used: 2500, limit: 5000, reset: R1 }]);
  });

  it("gives an empty take when no answer arrived since the last one", () => {
    const meter = usageMeter();
    meter.observe(rate(2500, R1));
    meter.takePeaks();

    expect(meter.takePeaks()).toEqual([]);
  });

  it("ignores answers without a complete set of rate-limit headers", () => {
    const meter = usageMeter();

    meter.observe(new Headers({ "x-ratelimit-used": "5", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(R1) }));
    meter.observe(new Headers({ "x-ratelimit-used": "five", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(R1), "x-ratelimit-resource": "core" }));
    meter.observe(rate(5, R1, "core", 0));

    expect(meter.current()).toEqual([]);
  });
});

describe("usage and peak log lines", () => {
  it("logs one github-api.usage line per resource with the identity and the share used", () => {
    const meter = usageMeter();
    meter.observe(rate(2600, R1));
    const { lines, log } = capture();

    logUsage(meter, "bot", log);

    expect(lines).toEqual([{ message: "github-api.usage", fields: { identity: "bot", resource: "core", used: 2600, limit: 5000, pct: 52, reset: new Date(R1 * 1000).toISOString() } }]);
  });

  it("logs a github-api.peak line per window touched since the last peak lines, then none until another answer", () => {
    const meter = usageMeter();
    meter.observe(rate(3100, R1));
    meter.observe(rate(40, R2));
    const { lines, log } = capture();

    logPeaks(meter, "bot", log);
    logPeaks(meter, "bot", log);

    expect(lines.map((line) => [line.message, line.fields.used, line.fields.reset])).toEqual([
      ["github-api.peak", 3100, new Date(R1 * 1000).toISOString()],
      ["github-api.peak", 40, new Date(R2 * 1000).toISOString()],
    ]);
  });
});
