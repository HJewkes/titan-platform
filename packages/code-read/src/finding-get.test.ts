import { describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/rpc-protocol";
import { answer, edge, file, memorySource, metric, snapshotInfo, symbol, type MemorySnapshot } from "./memory-source.js";
import { EXCERPT_LINE_CAP } from "./query/contract-findings.js";
import type { CommandResult } from "./query/contract.js";
import type { ModelFinding } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";

type Get = CommandResult<"finding.get">;
type Neighbors = CommandResult<"node.neighbors">;

const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

const importAt = (dest: string, line: number, lastLine = line): ModelFinding => ({
  id: `no-up|lib/f.ts|${dest}`, rule: "no-up", severity: "error", nodeId: "lib/f.ts", destinationId: dest,
  message: `lib/f.ts imports ${dest}`, ranges: [{ startLine: line, endLine: lastLine }],
});

const maxLoc = (nodeId: string, value: number): ModelFinding => ({
  id: `max-loc|${nodeId}`, rule: "max-loc", severity: "warning", nodeId, metric: "loc", value, threshold: 10, message: `loc=${value} > 10`,
});

const SNAPSHOT: MemorySnapshot = {
  info: snapshotInfo(1),
  nodes: [file("lib/f.ts"), file("lib/g.ts"), file("lib/long.ts"), file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), symbol("src/a.ts", "run", 1, 3)],
  metrics: [metric("lib/f.ts", "loc", 30), metric("lib/g.ts", "loc", 12), metric("lib/long.ts", "loc", 200), metric("src/a.ts", "loc", 3)],
  edges: [
    edge("lib/f.ts", "src/a.ts", "imports", 2), edge("lib/f.ts", "src/b.ts", "imports", 5), edge("lib/f.ts", "src/c.ts", "re-exports", 2),
    edge("lib/g.ts", "lib/f.ts", "imports", 1), edge("lib/f.ts", "src/a.ts#run", "references", 4), edge("src/b.ts", "src/a.ts#run", "references", 1),
  ],
  findings: [
    importAt("src/a.ts", 3), importAt("src/b.ts", 28), importAt("src/c.ts", 12, 13),
    maxLoc("lib/f.ts", 30), maxLoc("lib/g.ts", 12), maxLoc("lib/long.ts", 200),
    { ...importAt("src/a.ts", 10), id: "no-up|lib/long.ts|src/a.ts", nodeId: "lib/long.ts", ranges: [{ startLine: 10, endLine: 10 }, { startLine: 150, endLine: 150 }] },
  ],
  rules: [
    { id: "no-up", type: "forbid-import", severity: "error", text: "Files matching lib/** must not import src/**." },
    { id: "max-loc", type: "metric-max", severity: "warning", text: "loc must be at most 10." },
  ],
  sources: { "lib/f.ts": { lines: numbered(30) }, "lib/long.ts": { lines: numbered(200) }, "lib/g.ts": { lines: numbered(10).slice(4), startLine: 5, lineCount: 12 } },
};

const resolve = createQueryResolver(memorySource([SNAPSHOT]));
const get = (id: string, extra: Record<string, unknown> = {}): Get => answer(resolve)<Get>("finding.get", { id, ...extra });

describe("finding.get excerpts", () => {
  it("is exactly the flagged line plus 5 lines either side", () => {
    const { excerpt } = get("no-up|lib/f.ts|src/c.ts");

    expect(excerpt).toMatchObject({ startLine: 7, endLine: 18, highlights: [{ startLine: 12, endLine: 13 }], truncated: false });
    expect(excerpt?.text.split("\n")).toEqual(numbered(18).slice(6));
  });

  it("clips at the first line and at the last line of the file", () => {
    expect(get("no-up|lib/f.ts|src/a.ts").excerpt).toMatchObject({ startLine: 1, endLine: 8 });
    expect(get("no-up|lib/f.ts|src/b.ts").excerpt).toMatchObject({ startLine: 23, endLine: 30 });
  });

  it("honours context_lines, down to the flagged lines alone", () => {
    expect(get("no-up|lib/f.ts|src/c.ts", { context_lines: 0 }).excerpt?.text).toBe("line 12\nline 13");
    expect(get("no-up|lib/f.ts|src/c.ts", { context_lines: 20 }).excerpt).toMatchObject({ startLine: 1, endLine: 30 });
  });

  it("shows a whole-node finding from the top with no highlight, capped and marked truncated", () => {
    expect(get("max-loc|lib/f.ts").excerpt).toMatchObject({ startLine: 1, endLine: 30, highlights: [], truncated: false });
    expect(get("max-loc|lib/long.ts").excerpt).toMatchObject({ startLine: 1, endLine: EXCERPT_LINE_CAP, truncated: true });
  });

  it("drops highlights the capped window cannot show", () => {
    expect(get("no-up|lib/long.ts|src/a.ts").excerpt).toMatchObject({
      startLine: 5, endLine: 4 + EXCERPT_LINE_CAP, truncated: true, highlights: [{ startLine: 10, endLine: 10 }],
    });
  });

  it("says why when the source cannot cover the window", () => {
    expect(get("max-loc|lib/g.ts")).toMatchObject({ excerpt: null, excerptMissing: "not-in-export" });
  });

  it("says no-source when the source holds no text at all", () => {
    const bare = createQueryResolver(memorySource([{ ...SNAPSHOT, sources: undefined }]));

    expect(answer(bare)<Get>("finding.get", { id: "max-loc|lib/f.ts" })).toMatchObject({ excerpt: null, excerptMissing: "no-source" });
  });

  it("carries the origin and the file's content hash", () => {
    expect(get("max-loc|lib/f.ts").excerpt).toMatchObject({ path: "lib/f.ts", origin: "export", contentHash: "hash:lib/f.ts" });
  });
});

describe("finding.get context", () => {
  it("states the rule, the message, and the measured value against its peers", () => {
    const result = get("max-loc|lib/f.ts");

    expect(result.rule).toEqual({ id: "max-loc", type: "metric-max", severity: "warning", text: "loc must be at most 10." });
    expect(result.why).toBe("loc must be at most 10. Here: loc=30 > 10.");
    // Files' loc is 0, 0, 3, 12, 30, 200 (absent counts as 0), so 5 of 6 are at most 30; lib/ holds 12, 30, 200.
    expect(result.measured).toEqual({ value: 30, threshold: 10, percentile: 83.3, siblingMedian: 30 });
    expect(result.finding).toMatchObject({ excess: 3, provenance: { kind: "derived", source: "check/max-loc" } });
  });

  it("lists the same node's other findings, then the same rule on graph neighbours", () => {
    const related = get("max-loc|lib/f.ts").related.map((f) => f.id);

    expect(related).toEqual(["no-up|lib/f.ts|src/a.ts", "no-up|lib/f.ts|src/b.ts", "no-up|lib/f.ts|src/c.ts", "max-loc|lib/g.ts"]);
  });

  it("fails with NOINPUT for an id the snapshot does not hold", () => {
    expect(resolve("finding.get", { id: "max-loc|nowhere.ts" })).toMatchObject({ ok: false, code: EXIT.NOINPUT });
  });
});

describe("node.neighbors over a model", () => {
  const neighbors = (args: Record<string, unknown>): Neighbors => answer(resolve)<Neighbors>("node.neighbors", args);

  it("ranks by weight, then neighbour id, and leaves references off a file's list", () => {
    const { outbound, inbound, total } = neighbors({ id: "lib/f.ts" });

    expect(outbound.map((n) => [n.node.id, n.kind, n.weight])).toEqual([
      ["src/b.ts", "imports", 5], ["src/a.ts", "imports", 2], ["src/c.ts", "re-exports", 2],
    ]);
    expect(inbound.map((n) => n.node.id)).toEqual(["lib/g.ts"]);
    expect(total).toEqual({ inbound: 1, outbound: 3 });
  });

  it("keeps references for a symbol, whose only edges they are", () => {
    expect(neighbors({ id: "src/a.ts#run" }).inbound.map((n) => [n.node.id, n.weight])).toEqual([["lib/f.ts", 4], ["src/b.ts", 1]]);
  });

  it("filters by edge kind and direction, and pages each side", () => {
    expect(neighbors({ id: "lib/f.ts", edge_kinds: ["references"] }).outbound.map((n) => n.node.id)).toEqual(["src/a.ts#run"]);
    expect(neighbors({ id: "lib/f.ts", direction: "in" })).toMatchObject({ outbound: [], total: { outbound: 0, inbound: 1 } });
    expect(neighbors({ id: "lib/f.ts", offset: 1, limit: 1 }).outbound.map((n) => n.node.id)).toEqual(["src/a.ts"]);
  });

  it("reports each neighbour's metric values, null where the metric does not apply", () => {
    const [first] = neighbors({ id: "lib/g.ts", metrics: ["loc"] }).outbound;

    expect(first?.values).toEqual({ loc: 30 });
    expect(neighbors({ id: "lib/f.ts", edge_kinds: ["references"], metrics: ["loc"] }).outbound[0]?.values).toEqual({ loc: null });
  });

  it("rejects a synthesized directory and fails NOINPUT for an unknown id", () => {
    expect(resolve("node.neighbors", { id: "lib/" })).toMatchObject({ ok: false, code: EXIT.DATAERR });
    expect(resolve("node.neighbors", { id: "lib/zzz.ts" })).toMatchObject({ ok: false, code: EXIT.NOINPUT });
  });
});
