import type { MetricSpec } from "@titan-design/health/metrics";
import type { AuditAgentRequest, AuditPorts } from "../audit/ports.js";
import type { AuditInput } from "../audit/schemas.js";

/** The Shepherd hand audit's headline counts: the gold the workflow must reproduce within 10 percent. */
export const HAND_AUDIT_COUNTS = { proposed: 44, Y: 20, P: 16, N: 8, slices: 12, questions: { yes: 4, partly: 6, no: 5 }, reports: 9 } as const;

export const AUDIT_INPUT: AuditInput = {
  system: "shepherd",
  codeRoots: ["products/factory/src/shepherd", "products/factory/src/workflows"],
  stores: [
    { id: "ledger", kind: "sqlite", path: "/state/factory.sqlite3", readonly: true },
    { id: "health", kind: "http", url: "http://127.0.0.1:7410/health", readonly: true },
  ],
  surfaces: [
    { kind: "cli", ref: "titan-factory shepherd status" },
    { kind: "cli", ref: "titan-factory shepherd stats" },
  ],
  owner: "titan-coord",
  mode: "initial",
};

type Family = MetricSpec["family"];
type Captured = MetricSpec["source"]["captured"];

/**
 * Claimed captures per family. Flow claims one Y more than the hand audit found; that metric's query fails, so the
 * baseline step must demote it to P for the counts to match.
 */
const CLAIMS: readonly [Family, number, number, number][] = [
  ["availability", 2, 6, 0],
  ["flow", 8, 3, 1],
  ["quality", 4, 0, 2],
  ["owner-load", 4, 1, 0],
  ["cost", 1, 1, 3],
  ["business", 2, 4, 2],
];

/** The query text a fake store refuses, standing in for a table the code names but the ledger lacks. */
export const BROKEN_QUERY = "select count(*) from missing_table";

function metric(family: Family, index: number, captured: Captured, broken: boolean): MetricSpec {
  const id = `shepherd.${family}.m${index}`;
  const text = broken ? BROKEN_QUERY : `select count(*) from workflow_run -- ${id}`;
  return {
    id,
    family,
    title: `Metric ${index}`,
    definition: `Synthetic ${family} metric ${index}`,
    unit: "count",
    source: { anchor: `products/factory/src/shepherd/stats.ts#m${index}`, store: "ledger", captured },
    ...(captured === "N" ? {} : { query: { kind: "sql" as const, store: "ledger", text } }),
    cadence: "1d",
    surfaces: ["stats"],
    answers: [1 + (index % 15)],
  };
}

export function proposedMetrics(): MetricSpec[] {
  return CLAIMS.flatMap(([family, y, p, n]) => {
    const claims: Captured[] = [...Array<Captured>(y).fill("Y"), ...Array<Captured>(p).fill("P"), ...Array<Captured>(n).fill("N")];
    return claims.map((captured, index) => metric(family, index, captured, family === "flow" && index === 0));
  });
}

/** Five claimed yes (one through a status command that fails), six partly, four no. */
function questions() {
  const answer = (id: number) => (id <= 5 ? "yes" : id <= 11 ? "partly" : "no");
  const command = (id: number) => (id === 1 ? "titan-factory shepherd status" : id <= 5 ? "titan-factory shepherd stats --json" : id <= 8 ? "sqlite3 ledger" : undefined);
  return Array.from({ length: 15 }, (_, i) => ({ id: i + 1, text: `Question ${i + 1}?`, answerable: answer(i + 1), ...(command(i + 1) ? { command: command(i + 1) } : {}) }));
}

function gapSlices(metrics: readonly MetricSpec[]) {
  const gaps = metrics.filter((spec) => spec.source.captured !== "Y").map((spec) => spec.id);
  return Array.from({ length: 11 }, (_, i) => ({
    title: `Slice ${i + 1}`,
    done_when: `Slice ${i + 1} records its metric`,
    estimate: ((i % 3) + 1) as 1 | 2 | 3,
    metrics: gaps.filter((_, at) => at % 11 === i),
    unblocks: [1 + i],
  }));
}

const REPORTS = Array.from({ length: 9 }, (_, i) => ({ id: `r${i + 1}`, title: `Report ${i + 1}`, metrics: [`shepherd.flow.m${i}`] }));

/** Recorded agent answers per step, keyed by the step name in the manifest. */
export function recordedAgent(): (request: AuditAgentRequest) => Promise<unknown> {
  const metrics = proposedMetrics();
  const answers: Record<string, unknown> = {
    "inventory-code": { emitters: [{ kind: "step", name: "sh-review", at: "products/factory/src/shepherd/review.ts:10", persisted: true }] },
    purpose: { purpose: "Shepherd lands registered PRs.", users: ["owner", "seats"], questions: questions() },
    propose: { metrics },
    gaps: { slices: gapSlices(metrics) },
    plan: { reports: REPORTS },
  };
  return async ({ step }) => answers[step];
}

export interface FakeAuditPorts extends AuditPorts {
  written: Map<string, string>;
  agentCalls: AuditAgentRequest[];
  inventoried: string[];
}

export function fakeAuditPorts(overrides: Partial<AuditPorts> = {}): FakeAuditPorts {
  const written = new Map<string, string>();
  const agentCalls: AuditAgentRequest[] = [];
  const inventoried: string[] = [];
  const agent = overrides.agent ?? recordedAgent();
  return {
    written,
    agentCalls,
    inventoried,
    areas: async () => ["shepherd", "agent-chat"],
    prior: async () => null,
    codeRev: async () => "0123abcd",
    now: () => Date.parse("2026-10-09T00:00:00Z"),
    inventory: async (store) => (inventoried.push(store.id), { store: store.id, kind: store.kind, tables: [{ name: "workflow_run", columns: ["id"], rows: 3 }] }),
    query: async (_store, query) => {
      if (query.text === BROKEN_QUERY) throw new Error("no such table: missing_table");
      return { value: 3, n: 3 };
    },
    surface: async (command) => {
      if (command === "titan-factory shepherd status") throw new Error("exit 69");
      return `ran ${command}`;
    },
    writeReport: async (path, json) => void written.set(path, json),
    ...overrides,
    agent: async (request) => (agentCalls.push(request), agent(request)),
  };
}
