import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { indexPaths } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";
import { PY_FILES, TS_FILES, writeTree } from "./call-graph.test-helpers.js";
import type { GraphEdge, GraphMetric } from "./types.js";

let root: string;
let store: CodeGraphStore;
let calls: GraphEdge[];
let metrics: GraphMetric[];
let snapshotId: number;

beforeAll(async () => {
  root = await writeTree({ ...TS_FILES, ...PY_FILES });
  store = openCodeGraph(path.join(root, "graph.sqlite3"));
  ({ snapshotId } = await indexPaths(store, { paths: [root], computeChurn: false, detectRenames: false }));
  calls = store.listEdges(snapshotId, { includeReferences: true }).filter((e) => e.kind === "calls");
  metrics = store.listMetrics(snapshotId);
});

afterAll(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

const callEdge = (srcId: string, dstId: string) => calls.find((e) => e.srcId === srcId && e.dstId === dstId);
const metric = (nodeId: string, name: string) => metrics.find((m) => m.nodeId === nodeId && m.name === name)?.value;
const MAIN = "src/ts/main.ts";
const APP = "py/app.py";

describe("TypeScript call edges", () => {
  it("links a call to a function declared in the same file", () => {
    expect(callEdge(`${MAIN}#run`, `${MAIN}#helper`)).toBeDefined();
  });

  it("resolves a call through an imported barrel to the origin symbol", () => {
    expect(callEdge(`${MAIN}#run`, "src/ts/util.ts#origin")).toBeDefined();
    expect(calls.some((e) => e.dstId.startsWith("src/ts/barrel.ts"))).toBe(false);
  });

  it("emits nothing for a call into an external package", () => {
    expect(calls.some((e) => e.dstId.includes("extpkg") || e.dstId.includes("ext"))).toBe(false);
  });

  it("links `new` to the class, a typed method call to the method, and `this.` calls inside a class", () => {
    expect(callEdge(`${MAIN}#run`, `${MAIN}#Box`)).toBeDefined();
    expect(callEdge(`${MAIN}#run`, `${MAIN}#Box.size`)).toBeDefined();
    expect(callEdge(`${MAIN}#Box.size`, `${MAIN}#Box.inner`)).toBeDefined();
  });

  it("attributes a top-level call to the file", () => {
    expect(callEdge(MAIN, `${MAIN}#run`)).toBeDefined();
  });

  it("records each call site's literal arguments on the edge", () => {
    expect(callEdge(`${MAIN}#walk`, "src/ts/util.ts#origin")?.attrs).toEqual({
      sites: [{ args: ["true", '"slow"'] }],
    });
  });

  it("keeps call edges out of the default file-level edge list", () => {
    expect(store.listEdges(snapshotId).some((e) => e.kind === "calls")).toBe(false);
  });
});

describe("Python call edges", () => {
  it("(a) links a bare call to a def declared at module level in the same file", () => {
    expect(callEdge(`${APP}#entry`, `${APP}#_local`)).toBeDefined();
    expect(callEdge(`${APP}#entry`, `${APP}#Job`)).toBeDefined();
  });

  it("(b) links a name bound by `from <in-repo module> import` to that module's def, alias included", () => {
    expect(callEdge(`${APP}#entry`, "py/helpers.py#shared_util")?.attrs).toEqual({
      sites: [{ args: ["2"] }, { args: ["4"] }],
    });
  });

  it("(c) links `self.<name>()` to the method of the enclosing class", () => {
    expect(callEdge(`${APP}#Job.run`, `${APP}#Job._step`)).toBeDefined();
  });

  it("(c) follows `self.<name>()` to a method inherited from a base class in the same file", () => {
    expect(callEdge(`${APP}#Child.go`, `${APP}#Base._shared_step`)).toBeDefined();
  });

  it("drops attribute chains, `module.func`, calls on a call's result and parameter-shadowed names", () => {
    expect(calls.filter((e) => e.srcId.startsWith(APP)).map((e) => e.dstId).sort()).toEqual([
      `${APP}#Base._shared_step`,
      `${APP}#Job`,
      `${APP}#Job._step`,
      `${APP}#_local`,
      "py/helpers.py#shared_util",
    ]);
    expect(calls.some((e) => e.srcId === `${APP}#shadow`)).toBe(false);
  });
});

describe("call-graph metrics", () => {
  it("counts distinct callers, a file-level caller included", () => {
    expect(metric(`${MAIN}#shared`, "symbol_caller_count")).toBe(2);
    expect(metric(`${MAIN}#run`, "symbol_caller_count")).toBe(1);
    expect(metric(`${MAIN}#walk`, "symbol_caller_count")).toBe(0);
  });

  it("flags a private helper with exactly one calling symbol", () => {
    expect(metric(`${MAIN}#helper`, "symbol_single_caller_helper")).toBe(1);
    expect(metric(`${APP}#_local`, "symbol_single_caller_helper")).toBe(1);
    expect(metric(`${APP}#Job._step`, "symbol_single_caller_helper")).toBe(1);
  });

  it("does not flag a helper called from two functions", () => {
    expect(metric(`${MAIN}#shared`, "symbol_single_caller_helper")).toBe(0);
  });

  it("does not flag an exported function with one caller", () => {
    expect(metric(`${MAIN}#exportedOnce`, "symbol_single_caller_helper")).toBe(0);
  });

  it("counts a parameter passed the same literal at every site and one never passed", () => {
    // origin(true, "fast") and origin(true, "slow"): `flag` agrees, `n` is never passed, `mode` differs.
    expect(metric("src/ts/util.ts#origin", "symbol_constant_params")).toBe(2);
    // shared_util(2) and su(4): `a` differs, `b` is never passed.
    expect(metric("py/helpers.py#shared_util", "symbol_constant_params")).toBe(1);
  });

  it("writes no constant_params for a callable with a single call site", () => {
    expect(metric(`${MAIN}#lonely`, "symbol_constant_params")).toBeUndefined();
  });
});
