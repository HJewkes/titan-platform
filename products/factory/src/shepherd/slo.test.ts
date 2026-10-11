import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricSpec, MetricsEntry } from "@titan-design/health/metrics";
import { describe, expect, it } from "vitest";
import { SLO_QUERIES } from "./slo-queries.js";
import { evaluateSlo, formatSlo, readRegistry, SLO_STORE, type SloBase } from "./slo.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const EMPTY_COST = { prs: [], weeks: [], totals: { prs: 0, completePrs: 0, usd: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, unreadable: 0, p50Usd: null, p90Usd: null } };
const BASE: SloBase = { runs: [], gates: [], events: [], now: NOW, cost: async () => EMPTY_COST };

function metric(id: string, queryId: string | undefined, slo?: Partial<NonNullable<MetricSpec["slo"]>>): MetricSpec {
  return {
    id,
    family: "flow",
    title: id,
    definition: "d",
    unit: "count",
    source: { anchor: "a.ts#a", store: "ledger", captured: queryId ? "Y" : "N", ...(queryId ? {} : { gapSlice: "TP-1" }) },
    ...(queryId && { query: { kind: "cli" as const, store: SLO_STORE, text: queryId } }),
    cadence: "1d",
    ...(slo && { slo: { objective: "o", target: 0, op: "<=" as const, window: "7d" as const, alert: { threshold: 1, sustain: 1 }, ...slo } }),
    surfaces: ["stats"],
    answers: [],
  };
}

const entry = (metrics: MetricSpec[]): MetricsEntry => ({ schema: "titan.metrics/v1", area: "shepherd", owner: "seat", stores: [], metrics, reports: [], lastAudit: { at: "", codeRev: "", report: "" } });

describe("evaluateSlo", () => {
  it("passes a value inside its SLO and fails one outside it", async () => {
    const results = await evaluateSlo(entry([metric("ok", "availability.stuck-runs", { target: 0 }), metric("bad", "business.merges-per-day", { target: 60, op: ">=" })]), BASE);

    expect(results.map((r) => [r.id, r.value, r.status])).toEqual([
      ["ok", 0, "pass"],
      ["bad", 0, "fail"],
    ]);
  });

  it("evaluates each metric over its SLO window ending today, or seven days with no SLO", async () => {
    const results = await evaluateSlo(entry([metric("d", "business.merges-per-day", { window: "1d" }), metric("w", "business.merges-per-day", { window: "28d" }), metric("none", "business.merges-per-day")]), BASE);

    expect(results.map((r) => [r.from, r.to])).toEqual([
      ["2026-10-08", "2026-10-08"],
      ["2026-09-11", "2026-10-08"],
      ["2026-10-02", "2026-10-08"],
    ]);
    expect(results[2]!.status).toBe("no-slo");
  });

  it("uses an explicit range for every metric when given one", async () => {
    const [result] = await evaluateSlo(entry([metric("d", "business.merges-per-day", { window: "1d" })]), BASE, { from: "2026-10-01", to: "2026-10-04" });

    expect([result!.from, result!.to, result!.n]).toEqual(["2026-10-01", "2026-10-04", 4]);
  });

  it("reports no data rather than a zero when nothing in the window was measured", async () => {
    const [result] = await evaluateSlo(entry([metric("q", "flow.queued-p90", { target: 60 })]), BASE);

    expect([result!.value, result!.status]).toEqual([null, "no-data"]);
  });

  it("names the gap slice of a metric with no query, and errors on a query stats cannot run", async () => {
    const foreign = { ...metric("sql", "x"), query: { kind: "sql" as const, store: "ledger", text: "select 1" } };
    const results = await evaluateSlo(entry([metric("gap", undefined), metric("unknown", "no.such-query"), foreign]), BASE);

    expect(results.map((r) => [r.status, r.detail])).toEqual([
      ["no-query", "gap TP-1"],
      ["error", "unknown query no.such-query"],
      ["error", `not a ${SLO_STORE} query: sql on ledger`],
    ]);
  });

  it("records a query that throws as an error with no value", async () => {
    const cost = async () => Promise.reject(new Error("transcripts unreadable"));
    const [result] = await evaluateSlo(entry([metric("c", "cost.reviewer-usd-per-merge", { target: 1.5 })]), { ...BASE, cost });

    expect([result!.status, result!.value, result!.detail]).toEqual(["error", null, "transcripts unreadable"]);
  });
});

describe("formatSlo", () => {
  it("prints one line per metric and a tally", async () => {
    const results = await evaluateSlo(entry([metric("ok", "availability.stuck-runs", { target: 0 }), metric("gap", undefined)]), BASE);

    expect(formatSlo(results)).toBe(
      ["pass      ok  0 count  SLO <= 0 (o)  2026-10-02..2026-10-08  n 0", "no-query  gap  gap TP-1", "", "pass 1  fail 0  no-data 0  no-slo 0  no-query 1  error 0", ""].join("\n"),
    );
  });
});

describe("readRegistry", () => {
  it("reads a valid entry and refuses an invalid one naming the field", () => {
    const dir = mkdtempSync(join(tmpdir(), "slo-registry-"));
    try {
      writeFileSync(join(dir, "ok.yml"), JSON.stringify(entry([metric("ok", "availability.stuck-runs")])));
      writeFileSync(join(dir, "bad.yml"), JSON.stringify({ ...entry([]), owner: undefined }));

      expect(readRegistry(join(dir, "ok.yml")).metrics).toHaveLength(1);
      expect(() => readRegistry(join(dir, "bad.yml"))).toThrow(/owner/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("metrics/shepherd.yml", () => {
  const registry = readRegistry(new URL("../../../../metrics/shepherd.yml", import.meta.url).pathname);

  it("names a query shepherd stats can run for every metric that has one", () => {
    const queried = registry.metrics.flatMap((m) => (m.query ? [m.query] : []));

    expect(queried.filter((q) => q.kind !== "cli" || q.store !== SLO_STORE || !(q.text in SLO_QUERIES))).toEqual([]);
  });

  it("gives every metric without a query a gap slice, and every query a metric", () => {
    const used = new Set(registry.metrics.map((m) => m.query?.text));

    expect(registry.metrics.filter((m) => !m.query && !m.source.gapSlice).map((m) => m.id)).toEqual([]);
    expect(Object.keys(SLO_QUERIES).filter((id) => !used.has(id))).toEqual([]);
  });

  it("keeps metric ids unique and every report on a listed metric", () => {
    const ids = registry.metrics.map((m) => m.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(registry.reports.flatMap((r) => r.metrics).filter((id) => !ids.includes(id))).toEqual([]);
  });
});
