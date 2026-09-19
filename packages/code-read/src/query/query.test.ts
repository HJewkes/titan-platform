import { describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/rpc-protocol";
import { CODE_READ_API_VERSION, COMMAND_NAMES, CONTRACT } from "./contract.js";
import { buildReadModel, type CatalogueEntry, type ReadModel } from "./model.js";
import { createQueryResolver } from "./resolver.js";
import type { SnapshotInfo } from "./schemas.js";
import { snapshotNotFound, type ReadSource, type SourceFacts } from "./source.js";

const LOC: CatalogueEntry = {
  name: "loc", unit: "lines", appliesTo: ["file"], rollup: "sum", direction: "higher-worse",
  absent: "zero", source: "source-metrics", description: "Non-blank lines in the file.",
};

const snap = (id: number, ref: string, indexVersion = "0.14.0"): SnapshotInfo => ({
  id, ref, commit: null, takenAt: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`, indexVersion,
});

function model(snapshot: SnapshotInfo): ReadModel {
  return buildReadModel({
    snapshot,
    nodes: [
      { id: "a.ts", kind: "file", name: "a.ts", parentId: null, attrs: {} },
      { id: "a.ts#f", kind: "symbol", name: "f", parentId: "a.ts", attrs: {} },
    ],
    edges: [],
    aliases: [],
    metrics: [
      { nodeId: "a.ts#f", name: "mystery_score", value: 0.5 },
      { nodeId: "a.ts", name: "loc", value: 10, unit: "lines" },
    ],
    describe: (name) => (name === "loc" ? LOC : null),
  });
}

/** An in-memory source: the same seam a static dataset will implement. */
function memorySource(snapshots: SnapshotInfo[], overrides: Partial<SourceFacts> = {}): ReadSource {
  const facts: SourceFacts = {
    dataset: "static",
    commands: COMMAND_NAMES,
    capabilities: {
      findings: "none", verdicts: false, themes: false, feedback: false, embeddings: null,
      cochange: false, sourceAtCommit: false, excerpts: "none",
    },
    rules: [{ id: "max-file-loc", type: "metric-max", severity: "error" }],
    ...overrides,
  };
  return {
    facts: () => facts,
    snapshots: () => snapshots,
    model: (id) => {
      const s = snapshots.find((x) => x.id === id);
      if (!s) throw snapshotNotFound(id);
      return model(s);
    },
  };
}

const SNAPSHOTS = [snap(4, "main"), snap(3, "feature", "0.13.0"), snap(2, "main", "0.13.0"), snap(1, "main", "0.12.0")];

describe("api.describe", () => {
  it("reports the contract version, the newest snapshot, and index versions newest first", () => {
    const resolve = createQueryResolver(memorySource(SNAPSHOTS));

    const envelope = resolve("api.describe", {});

    expect(envelope).toMatchObject({
      ok: true,
      data: { api: CODE_READ_API_VERSION, dataset: "static", newest: SNAPSHOTS[0], indexVersions: ["0.14.0", "0.13.0", "0.12.0"] },
    });
  });

  it("describes catalogued metrics sorted by name, with engine provenance, and serves unknown ones without judgement", () => {
    const envelope = createQueryResolver(memorySource(SNAPSHOTS))("api.describe", {});
    const metrics = envelope.ok ? (envelope.data as { metrics: unknown[] }).metrics : [];

    expect(metrics).toEqual([
      expect.objectContaining({ name: "loc", rollup: "sum", provenance: { kind: "measured", source: "code-graph@0.14.0/source-metrics" } }),
      expect.objectContaining({ name: "mystery_score", unit: null, appliesTo: ["symbol"], rollup: "none", direction: "neutral" }),
    ]);
  });

  it("answers with no newest snapshot and no metrics for an empty store", () => {
    const envelope = createQueryResolver(memorySource([]))("api.describe", {});

    expect(envelope).toMatchObject({ ok: true, data: { newest: null, indexVersions: [], metrics: [] } });
  });

  it("returns a result its own result schema accepts", () => {
    const envelope = createQueryResolver(memorySource(SNAPSHOTS))("api.describe", {});

    expect(envelope.ok && CONTRACT["api.describe"].result.safeParse(envelope.data).success).toBe(true);
  });
});

describe("snapshot.list", () => {
  const resolve = createQueryResolver(memorySource(SNAPSHOTS));

  it("lists newest first, filtered to one ref and capped by limit", () => {
    expect(resolve("snapshot.list", { ref: "main", limit: 2 })).toEqual({ ok: true, data: { snapshots: [SNAPSHOTS[0], SNAPSHOTS[2]] } });
  });

  it("applies the default limit when args are omitted", () => {
    expect(resolve("snapshot.list", undefined)).toEqual({ ok: true, data: { snapshots: SNAPSHOTS } });
  });

  it("returns an empty list for a ref with no snapshots", () => {
    expect(resolve("snapshot.list", { ref: "nope" })).toEqual({ ok: true, data: { snapshots: [] } });
  });
});

describe("the query resolver's envelopes", () => {
  it("rejects bad arguments with DATAERR in the registry's wording", () => {
    const envelope = createQueryResolver(memorySource(SNAPSHOTS))("snapshot.list", { limit: 0 });

    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR });
    expect(!envelope.ok && envelope.error).toMatch(/^Invalid arguments: limit: /);
  });

  it("rejects an unknown command with USAGE", () => {
    expect(createQueryResolver(memorySource(SNAPSHOTS))("timeline.get", {})).toEqual({
      ok: false, error: "Unknown command: timeline.get", code: EXIT.USAGE,
    });
  });

  it("answers UNAVAILABLE for a command the source does not serve", () => {
    const resolve = createQueryResolver(memorySource(SNAPSHOTS, { commands: ["api.describe"] }));

    expect(resolve("snapshot.list", {})).toMatchObject({ ok: false, code: EXIT.UNAVAILABLE });
  });

  it("carries a query's own failure code, such as NOINPUT for a missing snapshot", () => {
    const broken: ReadSource = { ...memorySource([snap(9, "main")]), model: () => { throw snapshotNotFound(9); } };

    expect(createQueryResolver(broken)("api.describe", {})).toEqual({ ok: false, error: "No snapshot with id 9", code: EXIT.NOINPUT });
  });
});
