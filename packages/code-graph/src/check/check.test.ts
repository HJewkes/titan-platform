import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { runChecks } from "./check.js";

interface Fixture {
  dir: string;
  dbPath: string;
  snapshotId: number;
}

async function createFixture(
  populate: (db: CodeGraphStore, snapshotId: number) => void,
): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "codewatch-check-"));
  const dbPath = path.join(dir, "graph.db");
  const db = openCodeGraph(dbPath);
  const snapshotId = db.createSnapshot({
    ref: "main",
    indexVersion: "0.1.0",
  });
  populate(db, snapshotId);
  db.close();
  return { dir, dbPath, snapshotId };
}

describe("runChecks — metric-max", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("reports nodes whose value exceeds the max", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "small.ts", kind: "file", name: "small" },
        { id: "big.ts", kind: "file", name: "big" },
      ]);
      db.insertMetrics(snapshotId, [
        { nodeId: "small.ts", name: "loc", value: 10 },
        { nodeId: "big.ts", name: "loc", value: 1000 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "metric-max",
            id: "max-loc",
            metric: "loc",
            max: 500,
          },
        ],
      });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.nodeId).toBe("big.ts");
      expect(result.violations[0]!.value).toBe(1000);
      expect(result.violations[0]!.threshold).toBe(500);
    } finally {
      db.close();
    }
  });

  it("filters by kind", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "f.ts", kind: "file", name: "f" },
        { id: "m", kind: "module", name: "m" },
      ]);
      db.insertMetrics(snapshotId, [
        { nodeId: "f.ts", name: "loc", value: 100 },
        { nodeId: "m", name: "loc", value: 999 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          { type: "metric-max", id: "r", metric: "loc", max: 50, kind: "file" },
        ],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.nodeId).toBe("f.ts");
    } finally {
      db.close();
    }
  });

  it("respects excludeRoles", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "src/foo.ts", kind: "file", name: "foo", role: "source" },
        { id: "src/foo.test.ts", kind: "file", name: "foo.test", role: "test" },
        { id: "src/index.ts", kind: "file", name: "index", role: "barrel" },
      ]);
      db.insertMetrics(snapshotId, [
        { nodeId: "src/foo.ts", name: "loc", value: 999 },
        { nodeId: "src/foo.test.ts", name: "loc", value: 999 },
        { nodeId: "src/index.ts", name: "loc", value: 999 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "metric-max",
            id: "r",
            metric: "loc",
            max: 100,
            excludeRoles: ["test", "barrel"],
          },
        ],
      });
      expect(result.violations.map((v) => v.nodeId)).toEqual(["src/foo.ts"]);
    } finally {
      db.close();
    }
  });

  it("respects exclude patterns (glob and substring)", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "src/foo.ts", kind: "file", name: "foo" },
        { id: "src/__tests__/bar.test.ts", kind: "file", name: "bar.test" },
      ]);
      db.insertMetrics(snapshotId, [
        { nodeId: "src/foo.ts", name: "loc", value: 999 },
        { nodeId: "src/__tests__/bar.test.ts", name: "loc", value: 999 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "metric-max",
            id: "r",
            metric: "loc",
            max: 100,
            exclude: ["__tests__"],
          },
        ],
      });
      expect(result.violations.map((v) => v.nodeId)).toEqual(["src/foo.ts"]);
    } finally {
      db.close();
    }
  });

  it("skips nodes that don't have the metric", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [{ id: "ext", kind: "external", name: "ext" }]);
      db.insertMetrics(snapshotId, [{ nodeId: "ext", name: "fan_in", value: 5 }]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [{ type: "metric-max", id: "r", metric: "loc", max: 1 }],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("warning severity does not flip passed=false", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [{ id: "f.ts", kind: "file", name: "" }]);
      db.insertMetrics(snapshotId, [{ nodeId: "f.ts", name: "loc", value: 1000 }]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "metric-max",
            id: "r",
            metric: "loc",
            max: 100,
            severity: "warning",
          },
        ],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.passed).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("runChecks — metric-min", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("reports nodes whose value falls below the min", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "a", kind: "file", name: "a" },
        { id: "b", kind: "file", name: "b" },
      ]);
      db.insertMetrics(snapshotId, [
        { nodeId: "a", name: "fan_in", value: 0 },
        { nodeId: "b", name: "fan_in", value: 5 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [{ type: "metric-min", id: "r", metric: "fan_in", min: 1 }],
      });
      expect(result.violations.map((v) => v.nodeId)).toEqual(["a"]);
    } finally {
      db.close();
    }
  });
});

describe("runChecks — metric-product-max", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("flags nodes whose product of two metrics exceeds the max", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "calm.ts", kind: "file", name: "" },
        { id: "scary.ts", kind: "file", name: "" },
      ]);
      db.insertMetrics(snapshotId, [
        { nodeId: "calm.ts", name: "churn_30d", value: 50 },
        { nodeId: "calm.ts", name: "cyclomatic_max", value: 5 },
        { nodeId: "scary.ts", name: "churn_30d", value: 200 },
        { nodeId: "scary.ts", name: "cyclomatic_max", value: 25 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "metric-product-max",
            id: "scary-hotspots",
            metrics: ["churn_30d", "cyclomatic_max"],
            max: 1000,
          },
        ],
      });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.nodeId).toBe("scary.ts");
      expect(v.value).toBe(5000);
      expect(v.threshold).toBe(1000);
      expect(v.metric).toBe("churn_30d * cyclomatic_max");
      expect(v.message).toContain("churn_30d=200");
      expect(v.message).toContain("cyclomatic_max=25");
    } finally {
      db.close();
    }
  });

  it("skips nodes that are missing any of the named metrics", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "partial.ts", kind: "file", name: "" },
        { id: "complete.ts", kind: "file", name: "" },
      ]);
      db.insertMetrics(snapshotId, [
        { nodeId: "partial.ts", name: "churn_30d", value: 9999 },
        { nodeId: "complete.ts", name: "churn_30d", value: 100 },
        { nodeId: "complete.ts", name: "cyclomatic_max", value: 100 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "metric-product-max",
            id: "r",
            metrics: ["churn_30d", "cyclomatic_max"],
            max: 1000,
          },
        ],
      });
      expect(result.violations.map((v) => v.nodeId)).toEqual(["complete.ts"]);
    } finally {
      db.close();
    }
  });

  it("supports more than two metrics", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [{ id: "f.ts", kind: "file", name: "" }]);
      db.insertMetrics(snapshotId, [
        { nodeId: "f.ts", name: "a", value: 2 },
        { nodeId: "f.ts", name: "b", value: 3 },
        { nodeId: "f.ts", name: "c", value: 5 },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          { type: "metric-product-max", id: "r", metrics: ["a", "b", "c"], max: 29 },
        ],
      });
      expect(result.violations[0]!.value).toBe(30);
    } finally {
      db.close();
    }
  });

  it("respects kind and exclude filters", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "src/foo.ts", kind: "file", name: "" },
        { id: "src/__tests__/bar.test.ts", kind: "file", name: "" },
        { id: "mod", kind: "module", name: "" },
      ]);
      const big = [
        { name: "x", value: 100 },
        { name: "y", value: 100 },
      ];
      for (const id of ["src/foo.ts", "src/__tests__/bar.test.ts", "mod"]) {
        db.insertMetrics(snapshotId, big.map((m) => ({ nodeId: id, ...m })));
      }
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "metric-product-max",
            id: "r",
            metrics: ["x", "y"],
            max: 100,
            kind: "file",
            exclude: ["__tests__"],
          },
        ],
      });
      expect(result.violations.map((v) => v.nodeId)).toEqual(["src/foo.ts"]);
    } finally {
      db.close();
    }
  });
});

describe("runChecks — forbid-import", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  it("flags imports matching the from→to pattern", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "render/foo.ts", kind: "file", name: "" },
        { id: "cli/bar.ts", kind: "file", name: "" },
        { id: "render/baz.ts", kind: "file", name: "" },
      ]);
      db.insertEdges(snapshotId, [
        { srcId: "render/foo.ts", dstId: "cli/bar.ts", kind: "imports" },
        { srcId: "render/foo.ts", dstId: "render/baz.ts", kind: "imports" },
      ]);
    });

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            type: "forbid-import",
            id: "no-render-to-cli",
            from: "render/**",
            to: "cli/**",
          },
        ],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.nodeId).toBe("render/foo.ts");
      expect(result.violations[0]!.destinationId).toBe("cli/bar.ts");
    } finally {
      db.close();
    }
  });
});

describe("runChecks — layered-deps", () => {
  let fixture: Fixture;
  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  const layers: string[][] = [
    ["core"],
    ["analyzer", "graph"],
    ["render"],
    ["cli"],
  ];

  it("flags low-layer importing high-layer", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "core/foo.ts", kind: "file", name: "" },
        { id: "cli/bar.ts", kind: "file", name: "" },
      ]);
      db.insertEdges(snapshotId, [{
        srcId: "core/foo.ts",
        dstId: "cli/bar.ts",
        kind: "imports",
      }]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [{ id: "layers", type: "layered-deps", layers }],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.nodeId).toBe("core/foo.ts");
      expect(result.violations[0]!.destinationId).toBe("cli/bar.ts");
      expect(result.violations[0]!.message).toContain("layer 0");
      expect(result.violations[0]!.message).toContain("layer 3");
    } finally {
      db.close();
    }
  });

  it("allows same-layer cross-package imports", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "analyzer/a.ts", kind: "file", name: "" },
        { id: "graph/b.ts", kind: "file", name: "" },
      ]);
      db.insertEdges(snapshotId, [{
        srcId: "analyzer/a.ts",
        dstId: "graph/b.ts",
        kind: "imports",
      }]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [{ id: "layers", type: "layered-deps", layers }],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("allows high-layer importing low-layer (normal direction)", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "cli/a.ts", kind: "file", name: "" },
        { id: "core/b.ts", kind: "file", name: "" },
      ]);
      db.insertEdges(snapshotId, [{
        srcId: "cli/a.ts",
        dstId: "core/b.ts",
        kind: "imports",
      }]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [{ id: "layers", type: "layered-deps", layers }],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("skips edges where either side is not in any layer (externals, etc.)", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "core/foo.ts", kind: "file", name: "" },
        { id: "npm:lodash", kind: "external", name: "lodash" },
      ]);
      db.insertEdges(snapshotId, [{
        srcId: "core/foo.ts",
        dstId: "npm:lodash",
        kind: "imports",
      }]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [{ id: "layers", type: "layered-deps", layers }],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("matches real monorepo node ids via longest-prefix (packages/X/...)", async () => {
    // Regression test for the bug where packageHead() returned the first
    // path segment — for ids like "packages/cli/src/foo.ts" that was
    // always "packages", so layer matching silently failed and the
    // production package-layers rule was a no-op on real codewatch ids.
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        { id: "packages/core/src/foo.ts", kind: "file", name: "" },
        { id: "packages/cli/src/bar.ts", kind: "file", name: "" },
        { id: "packages/cli/src/sibling.ts", kind: "file", name: "" },
      ]);
      db.insertEdges(snapshotId, [
        // forbidden: low layer importing high layer
        {
          srcId: "packages/core/src/foo.ts",
          dstId: "packages/cli/src/bar.ts",
          kind: "imports",
        },
        // allowed: same package
        {
          srcId: "packages/cli/src/bar.ts",
          dstId: "packages/cli/src/sibling.ts",
          kind: "imports",
        },
      ]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "package-layers",
            type: "layered-deps",
            layers: [["packages/core"], ["packages/cli"]],
          },
        ],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.nodeId).toBe("packages/core/src/foo.ts");
      expect(result.violations[0]!.destinationId).toBe(
        "packages/cli/src/bar.ts",
      );
      expect(result.violations[0]!.message).toContain("packages/core");
      expect(result.violations[0]!.message).toContain("packages/cli");
    } finally {
      db.close();
    }
  });
});

describe("runChecks — no-internal-only-barrels", () => {
  let fixture: Fixture;
  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  const packageRoots = ["packages/analyzer", "packages/cli", "packages/core"];

  it("flags a barrel whose only importers are inside its own package", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        {
          id: "packages/analyzer/src/aggregator/index.ts",
          kind: "file",
          name: "",
          role: "barrel",
        },
        {
          id: "packages/analyzer/src/aggregator/foo.ts",
          kind: "file",
          name: "",
          role: "source",
        },
        {
          id: "packages/analyzer/src/something-else.ts",
          kind: "file",
          name: "",
          role: "source",
        },
      ]);
      db.insertEdges(snapshotId, [
        {
          srcId: "packages/analyzer/src/something-else.ts",
          dstId: "packages/analyzer/src/aggregator/index.ts",
          kind: "imports",
        },
      ]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "no-internal-only-barrels",
            type: "no-internal-only-barrels",
            packageRoots,
          },
        ],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.nodeId).toBe(
        "packages/analyzer/src/aggregator/index.ts",
      );
      expect(result.violations[0]!.message).toMatch(/1 internal/);
    } finally {
      db.close();
    }
  });

  it("does not flag a public-API barrel imported from another package", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        {
          id: "packages/analyzer/src/index.ts",
          kind: "file",
          name: "",
          role: "barrel",
        },
        {
          id: "packages/cli/src/foo.ts",
          kind: "file",
          name: "",
          role: "source",
        },
      ]);
      db.insertEdges(snapshotId, [{
        srcId: "packages/cli/src/foo.ts",
        dstId: "packages/analyzer/src/index.ts",
        kind: "imports",
      }]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots,
          },
        ],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("counts re-exports as importers (a re-exporting barrel makes the target public)", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        {
          id: "packages/analyzer/src/aggregator/index.ts",
          kind: "file",
          name: "",
          role: "barrel",
        },
        {
          id: "packages/analyzer/src/index.ts",
          kind: "file",
          name: "",
          role: "barrel",
        },
        {
          id: "packages/cli/src/use-it.ts",
          kind: "file",
          name: "",
          role: "source",
        },
      ]);
      db.insertEdges(snapshotId, [
        {
          srcId: "packages/analyzer/src/index.ts",
          dstId: "packages/analyzer/src/aggregator/index.ts",
          kind: "re-exports",
        },
        {
          srcId: "packages/cli/src/use-it.ts",
          dstId: "packages/analyzer/src/index.ts",
          kind: "imports",
        },
      ]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots,
          },
        ],
      });
      const flagged = result.violations.map((v) => v.nodeId).sort();
      expect(flagged).toEqual(["packages/analyzer/src/aggregator/index.ts"]);
    } finally {
      db.close();
    }
  });

  it("flags a barrel with zero importers (unused, internal by default)", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [{
        id: "packages/core/src/dead/index.ts",
        kind: "file",
        name: "",
        role: "barrel",
      }]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots,
          },
        ],
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.message).toMatch(/no importers/);
    } finally {
      db.close();
    }
  });

  it("ignores non-file kinds and non-barrel roles", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        {
          id: "packages/analyzer/src/aggregator/index",
          kind: "module",
          name: "",
          role: "barrel",
        },
        {
          id: "packages/analyzer/src/aggregator/foo.ts",
          kind: "file",
          name: "",
          role: "source",
        },
      ]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots,
          },
        ],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("skips barrels that fall outside every declared packageRoot", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [{
        id: "tools/scaffold/index.ts",
        kind: "file",
        name: "",
        role: "barrel",
      }]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots,
          },
        ],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("respects exclude patterns (e.g. for CLI bin entries the role classifier mislabels)", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        {
          id: "packages/cli/src/index.ts",
          kind: "file",
          name: "",
          role: "barrel",
        },
        {
          id: "packages/cli/src/commands/index.ts",
          kind: "file",
          name: "",
          role: "barrel",
        },
      ]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots,
            exclude: ["packages/cli/src/index.ts"],
          },
        ],
      });
      expect(result.violations.map((v) => v.nodeId)).toEqual([
        "packages/cli/src/commands/index.ts",
      ]);
    } finally {
      db.close();
    }
  });

  it("uses longest-prefix match so a nested packageRoot wins over its parent", async () => {
    fixture = await createFixture((db, snapshotId) => {
      db.insertNodes(snapshotId, [
        {
          id: "packages/analyzer/sub/src/index.ts",
          kind: "file",
          name: "",
          role: "barrel",
        },
        {
          id: "packages/analyzer/sub/src/foo.ts",
          kind: "file",
          name: "",
          role: "source",
        },
        {
          id: "packages/analyzer/src/uses-sub.ts",
          kind: "file",
          name: "",
          role: "source",
        },
      ]);
      db.insertEdges(snapshotId, [
        {
          srcId: "packages/analyzer/sub/src/foo.ts",
          dstId: "packages/analyzer/sub/src/index.ts",
          kind: "imports",
        },
        {
          srcId: "packages/analyzer/src/uses-sub.ts",
          dstId: "packages/analyzer/sub/src/index.ts",
          kind: "imports",
        },
      ]);
    });
    const db = openCodeGraph(fixture.dbPath);
    try {
      // The nested root "packages/analyzer/sub" beats "packages/analyzer",
      // so the importer in packages/analyzer/src/uses-sub.ts is treated
      // as external — the barrel is public to its own narrower package
      // and should not be flagged.
      const result = runChecks(db, {
        snapshotId: fixture.snapshotId,
        rules: [
          {
            id: "r",
            type: "no-internal-only-barrels",
            packageRoots: ["packages/analyzer", "packages/analyzer/sub"],
          },
        ],
      });
      expect(result.violations).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("runChecks — baseline", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  async function createTwoSnapshotFixture(
    populateBaseline: (db: CodeGraphStore, snapshotId: number) => void,
    populateHead: (db: CodeGraphStore, snapshotId: number) => void,
  ): Promise<{ fixture: Fixture; baselineId: number; headId: number }> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "codewatch-baseline-"));
    const dbPath = path.join(dir, "graph.db");
    const db = openCodeGraph(dbPath);
    const baselineId = db.createSnapshot({ ref: "baseline", indexVersion: "0.1.0" });
    populateBaseline(db, baselineId);
    const headId = db.createSnapshot({ ref: "head", indexVersion: "0.1.0" });
    populateHead(db, headId);
    db.close();
    return { fixture: { dir, dbPath, snapshotId: headId }, baselineId, headId };
  }

  it("marks identical violations as carryover and lets passed=true", async () => {
    const built = await createTwoSnapshotFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "huge.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "huge.ts", name: "loc", value: 9000 }]);
      },
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "huge.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "huge.ts", name: "loc", value: 9001 }]);
      },
    );
    fixture = built.fixture;

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: built.headId,
        rules: [{ id: "r", type: "metric-max", metric: "loc", max: 500 }],
        baselineSnapshotId: built.baselineId,
      });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.isCarryover).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.carryoverErrors).toBe(1);
      expect(result.newErrors).toBe(0);
    } finally {
      db.close();
    }
  });

  it("flags violations not present in baseline as new and fails when error severity", async () => {
    const built = await createTwoSnapshotFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "old.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "old.ts", name: "loc", value: 9000 }]);
      },
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [
          { id: "old.ts", kind: "file", name: "" },
          { id: "new.ts", kind: "file", name: "" },
        ]);
        db.insertMetrics(snapshotId, [
          { nodeId: "old.ts", name: "loc", value: 9000 },
          { nodeId: "new.ts", name: "loc", value: 1234 },
        ]);
      },
    );
    fixture = built.fixture;

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: built.headId,
        rules: [{ id: "r", type: "metric-max", metric: "loc", max: 500 }],
        baselineSnapshotId: built.baselineId,
      });
      expect(result.violations).toHaveLength(2);
      const byNode = new Map(result.violations.map((v) => [v.nodeId, v]));
      expect(byNode.get("old.ts")!.isCarryover).toBe(true);
      expect(byNode.get("new.ts")!.isCarryover).toBeUndefined();
      expect(result.passed).toBe(false);
      expect(result.newErrors).toBe(1);
      expect(result.carryoverErrors).toBe(1);
    } finally {
      db.close();
    }
  });

  it("treats forbid-import violations as carryover when the edge existed at baseline", async () => {
    const built = await createTwoSnapshotFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [
          { id: "render/a.ts", kind: "file", name: "" },
          { id: "cli/b.ts", kind: "file", name: "" },
        ]);
        db.insertEdges(snapshotId, [{
          srcId: "render/a.ts",
          dstId: "cli/b.ts",
          kind: "imports",
        }]);
      },
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [
          { id: "render/a.ts", kind: "file", name: "" },
          { id: "render/c.ts", kind: "file", name: "" },
          { id: "cli/b.ts", kind: "file", name: "" },
        ]);
        db.insertEdges(snapshotId, [
          { srcId: "render/a.ts", dstId: "cli/b.ts", kind: "imports" },
          { srcId: "render/c.ts", dstId: "cli/b.ts", kind: "imports" },
        ]);
      },
    );
    fixture = built.fixture;

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: built.headId,
        rules: [
          {
            id: "no-r2c",
            type: "forbid-import",
            from: "render/**",
            to: "cli/**",
          },
        ],
        baselineSnapshotId: built.baselineId,
      });
      expect(result.violations).toHaveLength(2);
      const carry = result.violations.filter((v) => v.isCarryover);
      const fresh = result.violations.filter((v) => !v.isCarryover);
      expect(carry).toHaveLength(1);
      expect(carry[0]!.nodeId).toBe("render/a.ts");
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.nodeId).toBe("render/c.ts");
      expect(result.passed).toBe(false);
    } finally {
      db.close();
    }
  });

  it("ignores violations that exist only in baseline (no head equivalent)", async () => {
    const built = await createTwoSnapshotFixture(
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "gone.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "gone.ts", name: "loc", value: 9999 }]);
      },
      (db, snapshotId) => {
        db.insertNodes(snapshotId, [{ id: "kept.ts", kind: "file", name: "" }]);
        db.insertMetrics(snapshotId, [{ nodeId: "kept.ts", name: "loc", value: 1 }]);
      },
    );
    fixture = built.fixture;

    const db = openCodeGraph(fixture.dbPath);
    try {
      const result = runChecks(db, {
        snapshotId: built.headId,
        rules: [{ id: "r", type: "metric-max", metric: "loc", max: 500 }],
        baselineSnapshotId: built.baselineId,
      });
      expect(result.violations).toEqual([]);
      expect(result.passed).toBe(true);
    } finally {
      db.close();
    }
  });
});
