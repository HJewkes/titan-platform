import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INDEX_VERSION, type CheckRule } from "@titan-design/code-graph";
import { EXIT, collectCliArgs, createRegistry, invokeCommand, type BaseContext } from "@titan-design/registry";
import { createLiveSource, type SnapshotStore } from "./live-source.js";
import { CODE_READ_API_VERSION, CONTRACT, type CommandName } from "./query/contract.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

const RULES: CheckRule[] = [
  { id: "max-file-loc", type: "metric-max", metric: "loc", kind: "file", max: 350 },
  { id: "no-node", type: "forbid-import", from: "src/**", to: "node:**", severity: "warning" },
];

const ctx = (): BaseContext => ({ warnings: [], format: "json" });

let repo: FixtureRepo;
const snapshotIds: number[] = [];
let head = "";

beforeAll(async () => {
  repo = await makeFixtureRepo();
  repo.commit("init");
  snapshotIds.push(await repo.index("main"));
  await repo.write("src/extra.ts", "export const extra = 1;\n");
  head = repo.commit("add extra");
  snapshotIds.push(await repo.index("feature"));
  snapshotIds.push(await repo.index("main"), await repo.index("main"));
}, 60_000);

afterAll(() => repo.cleanup());

async function call(name: CommandName, args: unknown, rules: readonly CheckRule[] = RULES) {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store, rules: () => rules });
  const { envelope } = await invokeCommand(registry.get(name)!, args, ctx());
  if (!envelope.ok) throw new Error(`${name} failed: ${envelope.error}`);
  return CONTRACT[name].result.parse(envelope.data);
}

describe("api.describe through the registry, over a real index", () => {
  it("reports the contract, the newest snapshot at HEAD, and the engine's index version", async () => {
    const result = await call("api.describe", {});

    expect(result).toMatchObject({ api: CODE_READ_API_VERSION, dataset: "live", indexVersions: [INDEX_VERSION] });
    expect(result.commands).toEqual(["api.describe", "snapshot.list"]);
    expect(result.newest).toMatchObject({ id: snapshotIds.at(-1), ref: "main", commit: head });
  });

  it("describes each stored metric from code-graph's catalogue with measured provenance", async () => {
    const { metrics } = await call("api.describe", {});
    const loc = metrics.find((m) => m.name === "loc");

    expect(loc).toMatchObject({ unit: "lines", rollup: "sum", appliesTo: ["file"] });
    expect(loc?.provenance).toEqual({ kind: "measured", source: `code-graph@${INDEX_VERSION}/source-metrics` });
    expect(metrics.map((m) => m.name)).toEqual([...metrics.map((m) => m.name)].sort());
  });

  it("lists the product's rules with the engine's default severity", async () => {
    const { rules } = await call("api.describe", {});

    expect(rules).toEqual([
      { id: "max-file-loc", type: "metric-max", severity: "error" },
      { id: "no-node", type: "forbid-import", severity: "warning" },
    ]);
  });

  it("reports no rules when the product supplies none", async () => {
    expect((await call("api.describe", {}, [])).rules).toEqual([]);
  });
});

describe("snapshot.list through the registry, over a real index", () => {
  it("lists every snapshot newest first with its commit", async () => {
    const { snapshots } = await call("snapshot.list", {});

    expect(snapshots.map((s) => s.id)).toEqual([...snapshotIds].reverse());
    expect(snapshots.at(-1)).toMatchObject({ ref: "main", indexVersion: INDEX_VERSION, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it("filters to one ref and caps by limit, with CLI flags coerced by the registry", async () => {
    const registry = createRegistry();
    registerCodeReadCommands(registry, { openStore: () => repo.store });
    const cmd = registry.get("snapshot.list")!;
    const args = collectCliArgs(cmd, [], { ref: "main", limit: "2" });

    const { envelope } = await invokeCommand(cmd, args, ctx());

    expect(envelope).toMatchObject({ ok: true, data: { snapshots: [{ id: snapshotIds[3] }, { id: snapshotIds[2] }] } });
  });

  it("rejects a limit above the contract's maximum with DATAERR", async () => {
    const registry = createRegistry();
    registerCodeReadCommands(registry, { openStore: () => repo.store });

    const { envelope } = await invokeCommand(registry.get("snapshot.list")!, { limit: 501 }, ctx());

    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR });
  });
});

describe("the live source's model cache", () => {
  function countingStore(): { store: SnapshotStore; loads: number[] } {
    const loads: number[] = [];
    const store: SnapshotStore = new Proxy(repo.store, {
      get(target, prop, receiver) {
        if (prop === "listNodes") return (id: number, opts?: { includeSymbols?: boolean }) => (loads.push(id), target.listNodes(id, opts));
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { store, loads };
  }

  it("keeps the three most recently used snapshots and reloads an evicted one", () => {
    const { store, loads } = countingStore();
    const source = createLiveSource({ openStore: () => store });
    const [a, b, c, d] = snapshotIds as [number, number, number, number];

    for (const id of [a, b, c, a, d]) source.model(id);

    expect(source.cachedSnapshots()).toEqual([c, a, d]);
    expect(loads).toEqual([a, b, c, d]);
    source.model(b);
    expect(loads).toEqual([a, b, c, d, b]);
    expect(source.cachedSnapshots()).toEqual([a, d, b]);
  });

  it("returns the identical model object on a cache hit", () => {
    const source = createLiveSource({ openStore: () => repo.store });

    expect(source.model(snapshotIds[0]!)).toBe(source.model(snapshotIds[0]!));
  });

  it("holds every node of a snapshot, symbols included, in its model", () => {
    const model = createLiveSource({ openStore: () => repo.store }).model(snapshotIds[0]!);

    expect(model.nodeById.get("src/math.ts#add")).toMatchObject({ kind: "symbol", parentId: "src/math.ts" });
    expect(model.metrics.get("loc")?.get("src/math.ts")).toBe(3);
  });

  it("opens the store once, lazily", () => {
    let opened = 0;
    const source = createLiveSource({ openStore: () => (opened++, repo.store) });

    expect(opened).toBe(0);
    source.snapshots();
    source.model(snapshotIds[0]!);
    expect(opened).toBe(1);
  });

  it("fails with NOINPUT for a snapshot id that does not exist", () => {
    const source = createLiveSource({ openStore: () => repo.store });

    expect(() => source.model(9999)).toThrow(expect.objectContaining({ code: EXIT.NOINPUT }));
  });
});
