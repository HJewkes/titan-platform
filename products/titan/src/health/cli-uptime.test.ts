import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSamples, openHealthStore, type HealthSampleInput } from "@titan-design/health";
import { runCli } from "../cli.js";

const END = "2026-10-09T09:00:00.000Z";
const HOUR_START = Date.parse(END) - 60 * 60_000;

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "titan-cli-uptime-"));
  dbPath = join(dir, "health.sqlite3");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function minute(n: number): string {
  return new Date(HOUR_START + n * 60_000 + 500).toISOString();
}

function factoryRow(n: number, status: "pass" | "fail", observed?: Record<string, unknown>): HealthSampleInput {
  return { ts: minute(n), target: "factory", kind: "http", status, ...(observed ? { observed } : {}) };
}

/** One row a minute for the hour, with `restartCount` taken from `restarts(n)` on pass rows. */
function seedHour(opts: { fail?: number[]; skip?: number[]; restarts?: (n: number) => number; unclean?: (n: number) => number }) {
  const rows: HealthSampleInput[] = [];
  for (let n = 0; n < 60; n++) {
    if (opts.skip?.includes(n)) continue;
    if (opts.fail?.includes(n)) {
      rows.push(factoryRow(n, "fail"));
      continue;
    }
    rows.push(factoryRow(n, "pass", { restartCount: opts.restarts?.(n) ?? 0, uncleanStartsTotal: opts.unclean?.(n) ?? 0 }));
  }
  seed(rows);
}

function seed(rows: HealthSampleInput[]): void {
  const db = openHealthStore(dbPath);
  try {
    appendSamples(db, rows);
  } finally {
    db.close();
  }
}

async function titan(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["health", ...argv], {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { XDG_STATE_HOME: join(dir, "state") },
    home: dir,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

async function uptimeJson(...extra: string[]) {
  const result = await titan("uptime", "factory", "--window", "1h", "--end", END, "--db", dbPath, "--json", ...extra);
  return { ...result, report: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("titan health uptime", () => {
  it("reports both shares and a gap without counting the missing minutes as up", async () => {
    seedHour({ fail: [10], skip: [20, 21, 22] });

    const { code, report } = await uptimeJson();

    expect(code).toBe(0);
    expect(report).toMatchObject({ target: "factory", slots: 60, up: 56, down: 1, unknown: 0, missing: 3 });
    expect(report.upShareOfWindow).toBeCloseTo(56 / 60);
    expect(report.upShareOfObserved).toBeCloseTo(56 / 57);
    expect(report.gaps).toEqual([{ from: "2026-10-09T08:20:00.000Z", to: "2026-10-09T08:23:00.000Z" }]);
  });

  it("reports restarts and unclean starts as deltas of serve's own counters", async () => {
    seedHour({ restarts: (n) => (n < 30 ? 3 : 5), unclean: (n) => (n < 45 ? 1 : 2) });

    const { report } = await uptimeJson();

    expect(report.restarts).toEqual({ first: 3, last: 5, delta: 2, counterReset: false });
    expect(report.uncleanStarts).toEqual({ first: 1, last: 2, delta: 1, counterReset: false });
  });

  it("flags a counter that dropped as a reset instead of a negative delta", async () => {
    seedHour({ restarts: (n) => (n < 30 ? 5 : 1) });

    const { report } = await uptimeJson();

    expect(report.restarts).toEqual({ first: 5, last: 1, delta: null, counterReset: true });
  });

  it("flags a reset even when the counter climbs back above its first reading", async () => {
    seedHour({ restarts: (n) => (n < 20 ? 3 : n < 40 ? 1 : 4) });

    const { report } = await uptimeJson();

    expect(report.restarts).toMatchObject({ delta: null, counterReset: true });
  });

  it("exits 1 when the window share is below --min", async () => {
    seedHour({ fail: [1] });

    const below = await uptimeJson("--min", "0.99");
    const atOrAbove = await uptimeJson("--min", "0.98");

    expect(below.code).toBe(1);
    expect(below.stderr).toContain("below --min 0.99");
    expect(atOrAbove.code).toBe(0);
  });

  it("prints the gaps longest first in text", async () => {
    seedHour({ skip: [5, 30, 31, 32] });

    const { code, stdout } = await titan("uptime", "factory", "--window", "1h", "--end", END, "--db", dbPath);

    expect(code).toBe(0);
    expect(stdout).toContain("missing 4");
    expect(stdout.indexOf("08:30:00")).toBeLessThan(stdout.indexOf("08:05:00"));
    expect(stdout).toMatch(/restarts 0\b/);
  });

  it("rejects a window it cannot parse as a usage error", async () => {
    seedHour({});

    const result = await titan("uptime", "factory", "--window", "soon", "--db", dbPath);

    expect(result.code).toBe(64);
  });

  it("exits 2 naming the path when the store does not exist", async () => {
    const missing = join(dir, "nope.sqlite3");

    const result = await titan("uptime", "factory", "--window", "1h", "--db", missing);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(missing);
  });
});

function selfRow(n: number, wallMs: number, cpuUserUs: number): HealthSampleInput {
  return {
    ts: minute(n),
    target: "titan-health-sampler",
    kind: "self",
    status: "pass",
    observed: {
      cpuUserUs,
      cpuSystemUs: 50_000,
      fsReadBlocks: 0,
      fsWriteBlocks: 8,
      voluntaryCtx: 40,
      involuntaryCtx: 2,
      maxRssKb: 50_000 + n,
      wallMs,
      targets: 1,
    },
  };
}

describe("titan health cost", () => {
  it("folds the self rows into ticks with mean and max per tick and the store size", async () => {
    seed([selfRow(1, 200, 150_000), selfRow(2, 400, 250_000), selfRow(3, 300, 200_000), factoryRow(1, "pass")]);

    const { code, stdout } = await titan("cost", "--window", "1h", "--end", END, "--db", dbPath, "--json");
    const cost = JSON.parse(stdout) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(cost).toMatchObject({
      ticks: 3,
      wallMs: { mean: 300, max: 400 },
      cpuMs: { mean: 250, max: 300 },
      fsWriteBlocks: { mean: 8, max: 8 },
      contextSwitches: { mean: 42, max: 42 },
      maxRssKb: 50_003,
    });
    expect(cost.store).toMatchObject({ rows: 4 });
    expect((cost.store as { bytes: number }).bytes).toBeGreaterThan(0);
  });

  it("reports zero ticks and no averages for a window without self rows", async () => {
    seed([factoryRow(1, "pass")]);

    const { code, stdout } = await titan("cost", "--window", "1h", "--end", END, "--db", dbPath);

    expect(code).toBe(0);
    expect(stdout).toContain("ticks 0");
  });
});
