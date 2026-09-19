import { describe, expect, it } from "vitest";
import { createQueryResolver } from "@titan-design/code-read/query";
import { fixtureDataset, FIXTURE_SNAPSHOT_ID } from "../test/fixture.js";
import { datasetSource } from "./dataset.js";

const resolve = createQueryResolver(datasetSource(fixtureDataset()));

describe("datasetSource", () => {
  it("serves the exported catalogue unchanged through api.describe", () => {
    const answer = resolve("api.describe", {});
    expect(answer.ok && (answer.data as { metrics: unknown }).metrics).toEqual(fixtureDataset().snapshots[0]!.catalogue);
  });

  it("rolls metrics up through code-read's own queries", () => {
    const answer = resolve("hierarchy.get", { snapshot: FIXTURE_SNAPSHOT_ID, depth: 1 });
    const nodes = answer.ok ? (answer.data as { nodes: Array<{ id: string; values: Record<string, number> }> }).nodes : [];
    expect(nodes.find((n) => n.id === "src/")?.values.loc).toBe(440);
  });

  it("answers a snapshot it does not hold as NOINPUT, like the daemon", () => {
    expect(resolve("node.get", { snapshot: 99, id: "src/io.ts" })).toMatchObject({ ok: false, code: 66 });
  });
});
