import { describe, expect, it } from "vitest";
import { healthReportSchema, healthSampleSchema, parseHealthReport, worstStatus } from "./index.js";

const V1_REPORT = {
  status: "warn",
  checks: {
    deploy: { status: "warn", observedValue: "rolled-back", output: "build failed" },
    github: { status: "pass" },
  },
  started_at: "2026-01-01T00:00:00.000Z",
  metrics: { event_loop: { p50_ms: 1, p99_ms: 12, max_ms: 40 } },
  ok: true,
  version: "0.6.0",
  pid: 4242,
  uptime_ms: 1000,
  port: 7410,
};

const SAMPLE = {
  ts: "2026-01-01T00:00:00.000Z",
  target: "factory",
  kind: "http",
  status: "pass",
  latencyMs: 12.5,
  observed: { code: 200, restartCount: 1 },
};

describe("worstStatus", () => {
  it("returns the worst of the statuses it is given", () => {
    expect(worstStatus(["pass", "warn", "pass"])).toBe("warn");
    expect(worstStatus(["warn", "fail", "pass"])).toBe("fail");
  });

  it("reads an empty list as pass", () => {
    expect(worstStatus([])).toBe("pass");
  });
});

describe("healthReportSchema (write)", () => {
  it("accepts a full health/v1 report", () => {
    expect(healthReportSchema.safeParse(V1_REPORT).success).toBe(true);
  });

  it("rejects a report with no status", () => {
    expect(healthReportSchema.safeParse({ ...V1_REPORT, status: undefined }).success).toBe(false);
  });

  it("rejects a status better than its worst check", () => {
    expect(healthReportSchema.safeParse({ ...V1_REPORT, status: "pass" }).success).toBe(false);
  });

  it("keeps product extension keys", () => {
    const parsed = healthReportSchema.parse({ ...V1_REPORT, runs: { running: 9 } });
    expect(parsed.runs).toEqual({ running: 9 });
  });
});

describe("parseHealthReport (read)", () => {
  it("reads a health/v1 report whose checks are warn and pass as warn", () => {
    const read = parseHealthReport(V1_REPORT);
    expect(read).toMatchObject({ ok: true, report: { status: "warn" } });
  });

  it("maps a legacy payload with ok true to pass and keeps its fields", () => {
    const read = parseHealthReport({ ok: true, pid: 4242, port: 7410 });
    expect(read).toEqual({ ok: true, report: { status: "pass", ok: true, pid: 4242, port: 7410 } });
  });

  it("maps a legacy payload with ok false to fail", () => {
    expect(parseHealthReport({ ok: false })).toMatchObject({ ok: true, report: { status: "fail" } });
  });

  it("lowers a reported status to its worst check", () => {
    const read = parseHealthReport({ status: "pass", checks: { db: { status: "fail" } } });
    expect(read).toMatchObject({ ok: true, report: { status: "fail" } });
  });

  it("keeps an unknown future field", () => {
    const read = parseHealthReport({ ...V1_REPORT, schemaRevision: 2 });
    expect(read).toMatchObject({ ok: true, report: { schemaRevision: 2 } });
  });

  it("reads the draft's up and down aliases", () => {
    expect(parseHealthReport({ status: "up" })).toMatchObject({ report: { status: "pass" } });
    expect(parseHealthReport({ status: "down" })).toMatchObject({ report: { status: "fail" } });
  });

  it("counts a check status it does not know as warn", () => {
    const read = parseHealthReport({ status: "pass", checks: { db: { status: "degraded" } } });
    expect(read).toMatchObject({ ok: true, report: { status: "warn", checks: { db: { status: "warn" } } } });
  });

  it("refuses a payload with neither status nor ok", () => {
    expect(parseHealthReport({ pid: 4242 })).toMatchObject({ ok: false });
    expect(parseHealthReport("ok")).toMatchObject({ ok: false });
  });
});

describe("healthSampleSchema (write)", () => {
  it("accepts a valid sample and defaults its source to probe", () => {
    expect(healthSampleSchema.parse(SAMPLE).source).toBe("probe");
  });

  it("accepts an unknown status, which a probe error produces", () => {
    expect(healthSampleSchema.safeParse({ ...SAMPLE, status: "unknown" }).success).toBe(true);
  });

  it("rejects a status outside pass, warn, fail and unknown", () => {
    expect(healthSampleSchema.safeParse({ ...SAMPLE, status: "up" }).success).toBe(false);
  });

  it("rejects a sample with no ts", () => {
    expect(healthSampleSchema.safeParse({ ...SAMPLE, ts: undefined }).success).toBe(false);
  });

  it("rejects a field it does not know", () => {
    expect(healthSampleSchema.safeParse({ ...SAMPLE, up: true }).success).toBe(false);
  });
});
