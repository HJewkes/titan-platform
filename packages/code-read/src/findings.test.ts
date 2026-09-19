import { describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/rpc-protocol";
import { answer, edge, file, memorySource, metric, snapshotInfo, symbol, type MemorySnapshot } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import type { ModelFinding, ModelRule } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";

type List = CommandResult<"findings.list">;
type Finding = List["rows"][number];

const RULES: ModelRule[] = [
  { id: "max-loc", type: "metric-max", severity: "error", text: "loc must be at most 10." },
  { id: "min-cov", type: "metric-min", severity: "warning", text: "cov must be at least 0.5." },
  { id: "no-lib-src", type: "forbid-import", severity: "error", text: "Files matching lib/** must not import src/**." },
];

function finding(rule: string, nodeId: string, severity: string, value?: number, threshold?: number, dest?: string): ModelFinding {
  const f: ModelFinding = { id: dest ? `${rule}|${nodeId}|${dest}` : `${rule}|${nodeId}`, rule, severity, nodeId, message: `${rule} on ${nodeId}` };
  if (value !== undefined) Object.assign(f, { metric: rule === "min-cov" ? "cov" : "loc", value, threshold });
  if (dest) f.destinationId = dest;
  return f;
}

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/sub/d.ts", "src/sub/e.ts", "lib/f.ts", "lib/g.ts", "lib/deep/h.ts"];

// Loc 20 on five files ties severity and excess, so only path, rule, and id can order them.
const CURRENT: ModelFinding[] = [
  ...FILES.map((id, i) => finding("max-loc", id, "error", i < 5 ? 20 : 15 + i, 10)),
  finding("min-cov", "src/a.ts", "warning", 0.25, 0.5),
  finding("min-cov", "src/sub/d.ts", "warning", 0.25, 0.5),
  finding("min-cov", "lib/g.ts", "warning", 0, 0.5),
  finding("no-lib-src", "lib/f.ts", "error", undefined, undefined, "src/a.ts"),
  finding("no-lib-src", "lib/f.ts", "error", undefined, undefined, "src/b.ts"),
  finding("no-lib-src", "lib/deep/h.ts", "error", undefined, undefined, "src/sub/d.ts"),
  finding("no-lib-src", "lib/g.ts", "error", undefined, undefined, "npm:left-pad"),
];

function snapshot(id: number, findings: ModelFinding[]): MemorySnapshot {
  return {
    info: snapshotInfo(id),
    nodes: [...FILES.map((f) => file(f)), symbol("src/a.ts", "run", 2, 4), { id: "npm:left-pad", kind: "external", name: "left-pad", parentId: null, attrs: {} }],
    metrics: FILES.map((f, i) => metric(f, "loc", 5 + i)),
    edges: [edge("lib/f.ts", "src/a.ts"), edge("lib/f.ts", "src/b.ts"), edge("src/b.ts", "src/c.ts")],
    findings,
    rules: RULES,
  };
}

// Baseline: d.ts's coverage finding was milder, c.ts's loc was worse, and one finding has since been fixed.
const BASELINE = [
  ...CURRENT.filter((f) => f.id !== "min-cov|src/sub/d.ts" && f.id !== "max-loc|src/c.ts"),
  finding("min-cov", "src/sub/d.ts", "warning", 0.4, 0.5),
  finding("max-loc", "src/c.ts", "error", 40, 10),
  finding("max-loc", "src/gone.ts", "error", 12, 10),
];

const source = memorySource([snapshot(2, CURRENT), snapshot(1, BASELINE)]);
const call = answer(createQueryResolver(source));
const list = (args: Record<string, unknown> = {}): List => call<List>("findings.list", args);
const ids = (rows: readonly Finding[]): string[] => rows.map((r) => r.id);

function allPages(args: Record<string, unknown>, size: number): Finding[] {
  const rows: Finding[] = [];
  for (let offset = 0; ; offset += size) {
    const page = list({ ...args, offset, limit: size });
    rows.push(...page.rows);
    if (offset + size >= page.total) return rows;
  }
}

describe("findings.list paging", () => {
  const SORTS = ["severity", "excess", "value", "path", "rule"].flatMap((sort) => [{ sort, order: "desc" }, { sort, order: "asc" }]);

  it.each(SORTS)("walks every row exactly once in pages of 3 ($sort $order)", (args) => {
    const whole = list({ ...args, limit: 500 });

    const paged = allPages(args, 3);

    expect(ids(paged)).toEqual(ids(whole.rows));
    expect(new Set(ids(paged)).size).toBe(whole.total);
    expect(whole.total).toBe(CURRENT.length);
  });

  it("returns only the total and facets with limit 0", () => {
    const headline = list({ limit: 0, facets: true });

    expect(headline.rows).toEqual([]);
    expect(headline.total).toBe(CURRENT.length);
    expect(headline.facets?.severity).toEqual({ error: 12, warning: 3 });
  });

  it("defaults to 20 rows", () => {
    const many = memorySource([snapshot(1, Array.from({ length: 30 }, (_, i) => finding("max-loc", `src/f${i}.ts`, "error", 11, 10)))]);

    const { rows, total } = answer(createQueryResolver(many))<List>("findings.list", {});

    expect([rows.length, total]).toEqual([20, 30]);
  });
});

describe("findings.list ordering", () => {
  it("puts errors first, then larger excess, then path, rule, and id on ties", () => {
    const { rows } = list({ limit: 500 });

    expect(ids(rows).slice(0, 8)).toEqual([
      "max-loc|lib/deep/h.ts",
      "max-loc|lib/g.ts",
      "max-loc|lib/f.ts",
      "max-loc|src/a.ts",
      "max-loc|src/b.ts",
      "max-loc|src/c.ts",
      "max-loc|src/sub/d.ts",
      "max-loc|src/sub/e.ts",
    ]);
    expect(ids(rows).slice(8, 12)).toEqual([
      "no-lib-src|lib/deep/h.ts|src/sub/d.ts",
      "no-lib-src|lib/f.ts|src/a.ts",
      "no-lib-src|lib/f.ts|src/b.ts",
      "no-lib-src|lib/g.ts|npm:left-pad",
    ]);
  });

  it("gives the same order whatever order the model holds the findings in", () => {
    const shuffled = memorySource([snapshot(1, [...CURRENT].reverse())]);

    const again = answer(createQueryResolver(shuffled))<List>("findings.list", { limit: 500 });

    expect(ids(again.rows)).toEqual(ids(list({ limit: 500 }).rows));
  });

  it("keeps findings without an excess last in both directions", () => {
    for (const order of ["asc", "desc"]) {
      const { rows } = list({ sort: "excess", order, limit: 500 });

      expect(rows.slice(-5).every((r) => r.excess === null)).toBe(true);
      expect(rows.slice(0, -5).every((r) => r.excess !== null)).toBe(true);
    }
  });

  it("scores a minimum rule's excess as threshold over value, so lower coverage ranks worse", () => {
    const { rows } = list({ rule: ["min-cov"], sort: "excess", limit: 500 });

    expect(rows.map((r) => [r.id, r.excess])).toEqual([
      ["min-cov|src/a.ts", 2],
      ["min-cov|src/sub/d.ts", 2],
      ["min-cov|lib/g.ts", null],
    ]);
  });
});

describe("findings.list filters and facets", () => {
  it.each([{}, { scope: "src/" }, { scope: "lib/", rule: ["no-lib-src"] }, { severity: ["warning"] }, { kind: ["file"], scope: "src/sub/" }])(
    "sums every facet to the total for %j",
    (args) => {
      const { total, facets } = list({ ...args, facets: true, limit: 0 });

      for (const counts of Object.values(facets!)) expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(total);
    },
  );

  it("splits a scope's findings by the child that holds them", () => {
    expect(list({ facets: true, limit: 0 }).facets?.child).toEqual({ "lib/": 8, "src/": 7 });
    expect(list({ scope: "src/", facets: true, limit: 0 }).facets?.child).toEqual({
      "src/a.ts": 2, "src/b.ts": 1, "src/c.ts": 1, "src/sub/": 3,
    });
  });

  it("holds everything under a directory scope and only the file under a file scope", () => {
    expect(list({ scope: "lib/deep/", limit: 500 }).total).toBe(2);
    expect(ids(list({ scope: "src/a.ts", limit: 500 }).rows)).toEqual(["max-loc|src/a.ts", "min-cov|src/a.ts"]);
  });

  it("labels every check finding derived with a check provenance", () => {
    const { facets, rows } = list({ facets: true, limit: 1 });

    expect(facets?.provenance).toEqual({ derived: 15 });
    expect(rows[0]?.provenance).toEqual({ kind: "derived", source: "check/max-loc" });
  });

  it("carries the destination of an import finding and a bare reference for an unknown node", () => {
    const [row] = list({ scope: "lib/g.ts", rule: ["no-lib-src"] }).rows;

    expect(row?.destination).toEqual({ id: "npm:left-pad", kind: "external", name: "left-pad", path: "npm:left-pad" });
  });

  it("fails with NOINPUT for a scope that is not in the snapshot", () => {
    const envelope = createQueryResolver(source)("findings.list", { scope: "nowhere/" });

    expect(envelope).toMatchObject({ ok: false, code: EXIT.NOINPUT });
  });
});

describe("findings.list against a baseline", () => {
  const byId = (rows: readonly Finding[]): Record<string, string | undefined> => Object.fromEntries(rows.map((r) => [r.id, r.status]));

  it("marks each finding new, carryover, worsened, or improved, and returns fixed ones as resolved", () => {
    const { rows, baselineSnapshotId, comparable } = list({ baseline: 1, limit: 500 });
    const status = byId(rows);

    expect({ baselineSnapshotId, comparable }).toEqual({ baselineSnapshotId: 1, comparable: true });
    expect(status["min-cov|src/sub/d.ts"]).toBe("worsened");
    expect(status["max-loc|src/c.ts"]).toBe("improved");
    expect(status["max-loc|src/gone.ts"]).toBe("resolved");
    expect(status["max-loc|src/a.ts"]).toBe("carryover");
    expect(rows.find((r) => r.status === "resolved")?.snapshotId).toBe(1);
  });

  it("filters and counts by status", () => {
    const { total, facets } = list({ baseline: 1, status: ["resolved", "worsened"], facets: true, limit: 0 });

    expect(total).toBe(2);
    expect(facets?.status).toEqual({ resolved: 1, worsened: 1 });
  });

  it("calls the same snapshot as its own baseline all carryover", () => {
    expect(new Set(list({ snapshot: 1, baseline: 1, limit: 500 }).rows.map((r) => r.status))).toEqual(new Set(["carryover"]));
  });

  it("rejects a status filter without a baseline", () => {
    expect(createQueryResolver(source)("findings.list", { status: ["new"] })).toMatchObject({ ok: false, code: EXIT.DATAERR });
  });
});
