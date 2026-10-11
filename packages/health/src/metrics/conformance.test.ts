import { describe, expect, it } from "vitest";
import { SHEPHERD_ENTRY } from "./fixtures.js";
import { validateEntry } from "./index.js";

// Built from the design's own interfaces (sections 1, 3.2 and 3.3) with every optional and nested field filled,
// not from the schema's types, so a schema that drifts from the spec fails here.
const STORES = [
  { id: "ledger", kind: "sqlite", path: "state/ledger.sqlite3", readonly: true },
  { id: "health", kind: "http", url: "http://127.0.0.1:7410/health", readonly: true },
  { id: "serve-log", kind: "log", path: "state/serve.log", readonly: true },
  { id: "tool", kind: "cli", command: "tool status --json", readonly: true },
  { id: "events", kind: "jsonl", path: "state/events.jsonl", readonly: true },
];

const FULL_METRIC = {
  id: "shepherd.flow.merge_verdict_to_merged",
  family: "flow",
  title: "MERGE to merged",
  definition: "Minutes from a MERGE verdict to the merge step",
  unit: "minutes",
  source: { anchor: "products/factory/src/shepherd/stats.ts#mergeVerdictAt", store: "ledger", captured: "P", gapSlice: "S2" },
  query: { kind: "sql", store: "ledger", text: "select 1", valuePath: "$.value", group: ["repo", "kind"] },
  cadence: "1h",
  slo: { objective: "p90 under 60 min", target: 60, op: "<=", window: "28d", alert: { threshold: 240, sustain: 3 } },
  surfaces: ["status", "stats", "health", "dashboard", "digest"],
  answers: [1, 2],
};

const REPORTS = [{ id: "flow", title: "Flow", metrics: [FULL_METRIC.id], view: "#/metrics", command: "tool report flow" }];

const FULL_ENTRY = {
  schema: "titan.metrics/v1",
  area: "shepherd",
  owner: "titan-coord",
  stores: STORES,
  metrics: [FULL_METRIC],
  reports: REPORTS,
  lastAudit: { at: "2026-10-08T00:00:00.000Z", codeRev: "abc1234", report: "audit.json" },
};

const FULL_AUDIT = {
  schema: "titan.measurement-audit/v1",
  system: "shepherd",
  mode: "reaudit",
  at: "2026-10-08T00:00:00.000Z",
  codeRev: "abc1234",
  inputs: {
    system: "shepherd",
    codeRoots: ["products/factory/src"],
    stores: STORES,
    surfaces: [
      { kind: "cli", ref: "tool status" },
      { kind: "http", ref: "/health" },
      { kind: "view", ref: "#/metrics" },
      { kind: "digest", ref: "factory digest" },
    ],
    sources: ["prior-plan.md"],
    owner: "titan-coord",
    mode: "reaudit",
  },
  inventory: { data: { tables: ["workflow_run"] }, emitters: { steps: ["sh-review"] } },
  purpose: "Merge reviewed PRs",
  users: ["owner", "seats"],
  questions: [{ id: 1, text: "How long do PRs wait?", answerable: "partly", command: "tool stats" }],
  metrics: [{ ...FULL_METRIC, baseline: { value: 12.5, n: 40, error: "none" } }],
  counts: { proposed: 1, Y: 0, P: 1, N: 0, slices: 1 },
  gaps: [{ rank: 1, metric: [FULL_METRIC.id], slice: { title: "Capture start", done_when: "recorded", estimate: 3 } }],
  reports: REPORTS,
  drift: [{ kind: "anchor-gone", metric: FULL_METRIC.id }],
  extra: { note: "free-form" },
};

// Fields the spec leaves untyped (named types it never defines, or Record<string, unknown>).
const OPEN_PATHS = [/^inventory\.(data|emitters)(\.|$)/, /^drift(\.|$)/, /^extra\./];

function paths(value: unknown, prefix: string[] = []): string[][] {
  if (typeof value !== "object" || value === null) return [prefix];
  const children = Object.entries(value).flatMap(([key, child]) => paths(child, [...prefix, key]));
  return [prefix, ...children].filter((path) => path.length > 0);
}

function withWrongTypeAt(root: unknown, path: string[]): unknown {
  const copy = structuredClone(root) as Record<string, unknown>;
  const parent = path.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, copy);
  const last = path[path.length - 1]!;
  parent[last] = typeof parent[last] === "object" && parent[last] !== null ? "wrong" : { wrong: true };
  return copy;
}

describe.each([
  ["titan.metrics/v1", FULL_ENTRY],
  ["titan.measurement-audit/v1", FULL_AUDIT],
])("spec conformance of %s", (_name, fixture) => {
  it("accepts a fully populated example in write and read mode", () => {
    expect(validateEntry(fixture, "write")).toMatchObject({ ok: true });
    expect(validateEntry(fixture, "read")).toMatchObject({ ok: true });
  });

  it("refuses a wrong type at every typed path on write", () => {
    const typed = paths(fixture).filter((path) => !OPEN_PATHS.some((open) => open.test(path.join("."))));
    const accepted = typed.filter((path) => validateEntry(withWrongTypeAt(fixture, path), "write").ok);
    expect(accepted.map((path) => path.join("."))).toEqual([]);
  });
});

describe("Shepherd fixture", () => {
  it("is accepted in both modes", () => {
    expect(validateEntry(SHEPHERD_ENTRY, "write").ok).toBe(true);
    expect(validateEntry(SHEPHERD_ENTRY, "read").ok).toBe(true);
  });
});
