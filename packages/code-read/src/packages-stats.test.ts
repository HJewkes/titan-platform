import { describe, expect, it } from "vitest";
import { answer, edge, file, memorySource, snapshotInfo, type MemorySnapshot } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import type { ModelRule } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";

type Stats = CommandResult<"packages.stats">;

const TIERS: ModelRule = {
  id: "tiers", type: "layered-deps", severity: "error", text: "Lower tiers never import higher ones.",
  layers: [["packages/a"], ["packages/b/"]],
};

// a imports its own types file and b; c imports a; the references edge and the test file's import are left out.
const SNAPSHOT: MemorySnapshot = {
  info: snapshotInfo(1),
  nodes: [
    file("packages/a/src/x.ts"),
    file("packages/a/src/types.ts", "types"),
    file("packages/a/src/x.test.ts", "test"),
    file("packages/b/src/y.ts"),
    file("packages/c/src/z.ts"),
    file("tools/script.ts"),
  ],
  metrics: [],
  edges: [
    edge("packages/a/src/x.ts", "packages/a/src/types.ts"),
    edge("packages/a/src/x.ts", "packages/b/src/y.ts"),
    edge("packages/c/src/z.ts", "packages/a/src/x.ts"),
    edge("packages/b/src/y.ts", "packages/a/src/x.ts", "references"),
    edge("packages/a/src/x.test.ts", "packages/b/src/y.ts"),
  ],
  findings: [{ id: "tiers|x", rule: "tiers", severity: "error", nodeId: "packages/a/src/x.ts", message: "a imports b" }],
  rules: [TIERS],
};

const UNRULED: MemorySnapshot = { ...SNAPSHOT, info: snapshotInfo(2), findings: [], rules: [] };

const resolve = createQueryResolver(memorySource([UNRULED, SNAPSHOT]));
const stats = (args: object = {}): Stats => answer(resolve)<Stats>("packages.stats", { snapshot: 1, ...args });

describe("packages.stats over the tier config", () => {
  it("measures each declared package with its tier, leaving undeclared files unassigned", () => {
    const result = stats();

    expect(result).toMatchObject({ snapshotId: 1, packagesFrom: "tiers", totalEdges: 2, unassignedFiles: 2 });
    expect(result.packages).toEqual([
      {
        id: "packages/a", name: "a", fileCount: 2, internalEdges: 1, outgoingEdges: 1, incomingEdges: 0,
        cohesion: 0.5, instability: 1, abstractness: 0.5, band: "top", flags: [],
        layer: { status: "declared", tier: 0, rule: "tiers" },
      },
      {
        id: "packages/b", name: "b", fileCount: 1, internalEdges: 0, outgoingEdges: 0, incomingEdges: 1,
        cohesion: 0, instability: 0, abstractness: 0, band: "foundation", flags: [],
        layer: { status: "declared", tier: 1, rule: "tiers" },
      },
    ]);
  });

  it("returns the cross-package edges and the partition's modularity", () => {
    const result = stats();

    expect(result.crossEdges).toEqual([{ from: "packages/a", to: "packages/b", edges: 1, intensity: 0.5, flag: "moderate" }]);
    expect(result.modularity).toBeCloseTo(-0.125);
  });
});

describe("packages.stats over given roots", () => {
  it("measures the given roots and marks one no tier names undeclared", () => {
    const result = stats({ packages: ["packages/c", "packages/a/", "packages/a"] });

    expect(result.packagesFrom).toBe("args");
    expect(result.packages.map((p) => [p.id, p.incomingEdges, p.outgoingEdges, p.layer])).toEqual([
      ["packages/a", 1, 0, { status: "declared", tier: 0, rule: "tiers" }],
      ["packages/c", 0, 1, { status: "undeclared" }],
    ]);
    expect(result.unassignedFiles).toBe(2);
  });

  it("answers no packages, rather than an error, when neither the rules nor the args name one", () => {
    const result = stats({ snapshot: 2 });

    expect(result).toEqual({ snapshotId: 2, packagesFrom: "none", modularity: 0, totalEdges: 0, unassignedFiles: 5, packages: [], crossEdges: [] });
  });
});

describe("finding.get on a layered-deps finding", () => {
  it("returns the rule without its tier config", () => {
    const result = answer(resolve)<CommandResult<"finding.get">>("finding.get", { snapshot: 1, id: "tiers|x" });

    expect(result.rule).toEqual({ id: "tiers", type: "layered-deps", severity: "error", text: TIERS.text });
  });
});
