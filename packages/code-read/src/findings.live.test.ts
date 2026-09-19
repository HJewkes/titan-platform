import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks, violationKey, type CheckRule } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { createLiveSource, type CodeReadDeps } from "./live-source.js";
import { answer } from "./memory-source.js";
import { CONTRACT, type CommandName, type CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

const header = (n: number): string => Array.from({ length: n }, (_, i) => `// header ${i + 1}`).join("\n");

// lib/ reaches up into src/ on line 8 and into node: on line 2, so import findings land mid-file and near the top.
const PLANTED: Record<string, string> = {
  "lib/bridge.ts": `${header(7)}\nimport { add } from "../src/math.js";\n\nexport const two = add(1, 1);\n${header(6)}\n`,
  "lib/io.ts": '// io\nimport { readFileSync } from "node:fs";\n\nexport const read = (p: string): string => readFileSync(p, "utf8");\n',
  "lib/wide.ts": Array.from({ length: 10 }, (_, i) => `export const w${i} = ${i};`).join("\n") + "\n",
  "src/big.ts": Array.from({ length: 12 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n",
};

const RULES: CheckRule[] = [
  { id: "max-loc", type: "metric-max", metric: "loc", kind: "file", max: 8 },
  { id: "max-cyclo", type: "metric-max", metric: "cyclomatic_max", kind: "file", max: 1, severity: "warning" },
  { id: "no-lib-to-src", type: "forbid-import", from: "lib/**", to: "src/**" },
  { id: "no-node-in-lib", type: "forbid-import", from: "lib/**", to: "node:**", severity: "warning" },
  { id: "layers", type: "layered-deps", layers: [["lib"], ["src"]] },
];

let repo: FixtureRepo;
let first = 0;
let second = 0;

beforeAll(async () => {
  repo = await makeFixtureRepo();
  for (const [file, text] of Object.entries(PLANTED)) await repo.write(file, text);
  repo.commit("plant");
  first = await repo.index("main");
  await repo.write("lib/wide.ts", "export const w = 1;\n");
  await repo.write("src/big.ts", `${PLANTED["src/big.ts"]}export const more = 1;\n`);
  await repo.write("src/new.ts", Array.from({ length: 9 }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n");
  repo.commit("shrink wide, grow big, add new");
  second = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

const deps = (extra: Partial<CodeReadDeps> = {}): CodeReadDeps => ({ openStore: () => repo.store, rules: () => RULES, repoRoot: repo.dir, ...extra });

async function call<N extends CommandName>(name: N, args: unknown): Promise<CommandResult<N>> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, deps());
  const { envelope } = await invokeCommand(registry.get(name)!, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`${name} failed: ${envelope.error}`);
  return CONTRACT[name].result.parse(envelope.data) as CommandResult<N>;
}

const fileLines = (file: string): string[] => readFileSync(path.join(repo.dir, file), "utf8").split("\n");

describe("findings.list over a real index", () => {
  it("returns exactly the violations code-graph's check reports, keyed by violationKey", async () => {
    const expected = runChecks(repo.store, { snapshotId: second, rules: RULES }).violations.map(violationKey).sort();

    const { rows, total } = await call("findings.list", { limit: 500 });

    expect(rows.map((r) => r.id).sort()).toEqual(expected);
    expect(total).toBe(expected.length);
  });

  it("finds planted violations of five rules across two directories", async () => {
    const { facets } = await call("findings.list", { snapshot: first, limit: 0, facets: true });

    expect(Object.keys(facets!.rule!)).toEqual(["layers", "max-cyclo", "max-loc", "no-lib-to-src", "no-node-in-lib"]);
    expect(Object.keys(facets!.child!)).toEqual(["lib/", "src/"]);
  });

  it("gives each finding a status against the baseline, with the fixed one back as resolved", async () => {
    const { rows } = await call("findings.list", { baseline: first, rule: ["max-loc"], limit: 500 });

    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      "max-loc|src/big.ts": "worsened",
      "max-loc|src/new.ts": "new",
      "max-loc|lib/bridge.ts": "carryover",
      "max-loc|lib/wide.ts": "resolved",
    });
  });
});

describe("finding.get over a real index", () => {
  it("locates an import finding on its import line and excerpts 5 lines either side from disk", async () => {
    const { finding, excerpt } = await call("finding.get", { id: "no-lib-to-src|lib/bridge.ts|src/math.ts" });

    expect(finding.range).toEqual({ startLine: 8, endLine: 8 });
    expect(excerpt).toMatchObject({ startLine: 3, endLine: 13, origin: "worktree", highlights: [{ startLine: 8, endLine: 8 }] });
    expect(excerpt!.text).toBe(fileLines("lib/bridge.ts").slice(2, 13).join("\n"));
  });

  it("clips an excerpt at both ends of a short file", async () => {
    const { excerpt } = await call("finding.get", { id: "no-node-in-lib|lib/io.ts|node:fs" });

    expect(excerpt).toMatchObject({ startLine: 1, endLine: 4, highlights: [{ startLine: 2, endLine: 2 }] });
  });

  it("explains the rule and measures a metric finding", async () => {
    const result = await call("finding.get", { id: "max-loc|src/big.ts", baseline: first });

    expect(result.why).toBe("loc must be at most 8 on each file. Here: loc=13 > 8.");
    expect(result.measured).toMatchObject({ value: 13, threshold: 8, baselineValue: 12 });
    expect(result.finding.status).toBe("worsened");
  });
});

describe("node.neighbors over a real index", () => {
  const key = (src: string, dst: string, kind: string): string => `${src} ${kind} ${dst}`;

  it("matches a brute-force scan of every edge and code-graph's targeted read, for every stored node", async () => {
    const all = repo.store.listEdges(second, { includeReferences: true });
    const nodes = repo.store.listNodes(second, { includeSymbols: true });

    for (const node of nodes) {
      const keep = (kind: string): boolean => node.kind === "symbol" || kind !== "references";
      const { inbound, outbound } = await call("node.neighbors", { id: node.id, limit: 100 });
      const got = [...inbound.map((n) => key(n.node.id, node.id, n.kind)), ...outbound.map((n) => key(node.id, n.node.id, n.kind))].sort();
      const scanned = all.filter((e) => (e.srcId === node.id || e.dstId === node.id) && keep(e.kind)).map((e) => key(e.srcId, e.dstId, e.kind));
      const targeted = repo.store.listEdgesTouching(second, node.id, { includeReferences: true }).filter((e) => keep(e.kind));

      expect(got, node.id).toEqual(scanned.sort());
      expect(got, node.id).toEqual(targeted.map((e) => key(e.srcId, e.dstId, e.kind)).sort());
    }
  });

  it("orders each side heaviest first", async () => {
    const { inbound } = await call("node.neighbors", { id: "src/math.ts" });

    expect(inbound.map((n) => n.weight ?? -1)).toEqual([...inbound.map((n) => n.weight ?? -1)].sort((a, b) => b - a));
    expect(inbound.map((n) => n.node.id)).toContain("lib/bridge.ts");
  });
});

describe("derived findings follow the rules and the working tree", () => {
  it("drops a finding when the rule changes, because it is computed on read", () => {
    let rules = RULES;
    const resolve = answer(createQueryResolver(createLiveSource(deps({ rules: () => rules }))));
    const count = (): number => resolve<CommandResult<"findings.list">>("findings.list", { rule: ["max-loc"], limit: 0 }).total;

    const before = count();
    rules = RULES.map((r) => (r.id === "max-loc" ? { ...r, max: 100 } : r));

    expect([before, count()]).toEqual([3, 0]);
  });

  it("refuses an excerpt once the file no longer matches its snapshot", async () => {
    await repo.write("lib/bridge.ts", `// edited\n${PLANTED["lib/bridge.ts"]}`);
    const resolve = answer(createQueryResolver(createLiveSource(deps())));

    const result = resolve<CommandResult<"finding.get">>("finding.get", { id: "no-lib-to-src|lib/bridge.ts|src/math.ts" });

    expect(result).toMatchObject({ excerpt: null, excerptMissing: "changed-since-snapshot" });
    expect(result.finding.range).toBeUndefined();
  });

  it("serves no excerpts without a repo root", () => {
    const resolve = answer(createQueryResolver(createLiveSource(deps({ repoRoot: null }))));

    expect(resolve<CommandResult<"finding.get">>("finding.get", { id: "max-loc|src/big.ts" }).excerptMissing).toBe("no-source");
    expect(resolve<CommandResult<"api.describe">>("api.describe", {}).capabilities).toMatchObject({ findings: "check-rules", excerpts: "none" });
  });
});
