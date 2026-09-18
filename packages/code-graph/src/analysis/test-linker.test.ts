import { describe, it, expect } from "vitest";
import {
  linkTestsToSources,
  testCoverageCountMetrics,
  type TestSourceLink,
} from "./test-linker.js";
import type { CoEditPair } from "../history/index.js";
import type { GraphNode, NodeRole } from "../types.js";

function file(id: string, role: NodeRole): GraphNode {
  return { id, kind: "file", name: id.split("/").pop()!, role };
}

function pair(fileA: string, fileB: string, count: number): CoEditPair {
  // change-coupling sorts fileA < fileB; mirror that for realism.
  const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA];
  return { fileA: a, fileB: b, count, commits: [] };
}

function link(testId: string, sourceId: string): Omit<TestSourceLink, "method"> {
  return { testId, sourceId };
}

describe("linkTestsToSources — pass 1 (path heuristics)", () => {
  it("pairs a co-located *.test.ts with its sibling source", () => {
    const links = linkTestsToSources(
      [file("src/foo.test.ts", "test"), file("src/foo.ts", "source")],
      [],
    );
    expect(links).toEqual([
      { testId: "src/foo.test.ts", sourceId: "src/foo.ts", method: "path" },
    ]);
  });

  it("pairs a *.spec.ts the same way", () => {
    const links = linkTestsToSources(
      [file("src/bar.spec.ts", "test"), file("src/bar.ts", "source")],
      [],
    );
    expect(links).toEqual([
      { testId: "src/bar.spec.ts", sourceId: "src/bar.ts", method: "path" },
    ]);
  });

  it("collapses a __tests__/ directory segment to find the source", () => {
    const links = linkTestsToSources(
      [
        file("src/__tests__/roles.test.ts", "test"),
        file("src/roles.ts", "source"),
      ],
      [],
    );
    expect(links).toEqual([
      {
        testId: "src/__tests__/roles.test.ts",
        sourceId: "src/roles.ts",
        method: "path",
      },
    ]);
  });

  it("collapses a tests/ directory segment", () => {
    const links = linkTestsToSources(
      [file("pkg/tests/util.test.ts", "test"), file("pkg/util.ts", "source")],
      [],
    );
    expect(links.map((l) => link(l.testId, l.sourceId))).toContainEqual(
      link("pkg/tests/util.test.ts", "pkg/util.ts"),
    );
  });

  it("links a non-test file inside __tests__/ (helper) to its sibling", () => {
    // A file under __tests__/ with no .test infix is still role=test by dir.
    const links = linkTestsToSources(
      [
        file("src/__tests__/helpers.ts", "test"),
        file("src/helpers.ts", "source"),
      ],
      [],
    );
    expect(links.map((l) => link(l.testId, l.sourceId))).toContainEqual(
      link("src/__tests__/helpers.ts", "src/helpers.ts"),
    );
  });

  it("pairs against a non-source role (e.g. a barrel index.ts)", () => {
    const links = linkTestsToSources(
      [file("src/index.test.ts", "test"), file("src/index.ts", "barrel")],
      [],
    );
    expect(links).toEqual([
      { testId: "src/index.test.ts", sourceId: "src/index.ts", method: "path" },
    ]);
  });
});

describe("linkTestsToSources — orphans", () => {
  it("leaves an orphan test (no matching source) unpaired", () => {
    const links = linkTestsToSources(
      [file("src/ghost.test.ts", "test"), file("src/other.ts", "source")],
      [],
    );
    expect(links).toEqual([]);
  });

  it("leaves an orphan (untested) source with no incoming link", () => {
    const links = linkTestsToSources(
      [
        file("src/a.test.ts", "test"),
        file("src/a.ts", "source"),
        file("src/untested.ts", "source"),
      ],
      [],
    );
    expect(links.some((l) => l.sourceId === "src/untested.ts")).toBe(false);
    expect(links.map((l) => link(l.testId, l.sourceId))).toContainEqual(link("src/a.test.ts", "src/a.ts"));
  });
});

describe("linkTestsToSources — one-to-many", () => {
  it("links one source covered by several tests", () => {
    const links = linkTestsToSources(
      [
        file("src/wide.test.ts", "test"),
        file("src/__tests__/wide.test.ts", "test"),
        file("src/wide.ts", "source"),
      ],
      [],
    );
    expect(links.map((l) => link(l.testId, l.sourceId))).toEqual([
      link("src/wide.test.ts", "src/wide.ts"),
      link("src/__tests__/wide.test.ts", "src/wide.ts"),
    ]);
  });

  it("links one test that matches several sources", () => {
    // Both a co-located and a __tests__/-collapsed candidate exist as nodes.
    const links = linkTestsToSources(
      [
        file("src/__tests__/multi.test.ts", "test"),
        file("src/__tests__/multi.ts", "source"),
        file("src/multi.ts", "source"),
      ],
      [],
    );
    expect(links.map((l) => l.sourceId).sort()).toEqual([
      "src/__tests__/multi.ts",
      "src/multi.ts",
    ]);
    expect(links.every((l) => l.method === "path")).toBe(true);
  });
});

describe("linkTestsToSources — pass 2 (co-edit supplement)", () => {
  it("supplements a path-orphan test with its strongest co-edited source", () => {
    const links = linkTestsToSources(
      [file("src/weird-name.test.ts", "test"), file("src/engine.ts", "source")],
      [pair("src/weird-name.test.ts", "src/engine.ts", 4)],
    );
    expect(links).toEqual([
      {
        testId: "src/weird-name.test.ts",
        sourceId: "src/engine.ts",
        method: "coedit",
      },
    ]);
  });

  it("does not use co-edit when a path link already exists", () => {
    const links = linkTestsToSources(
      [file("src/foo.test.ts", "test"), file("src/foo.ts", "source")],
      [pair("src/foo.test.ts", "src/other.ts", 9)],
    );
    expect(links).toEqual([
      { testId: "src/foo.test.ts", sourceId: "src/foo.ts", method: "path" },
    ]);
  });

  it("does not add a co-edit link to a real source once a path link exists", () => {
    const links = linkTestsToSources(
      [file("src/foo.test.ts", "test"), file("src/foo.ts", "source"), file("src/other.ts", "source")],
      [pair("src/foo.test.ts", "src/other.ts", 9)],
    );
    expect(links).toEqual([{ testId: "src/foo.test.ts", sourceId: "src/foo.ts", method: "path" }]);
  });

  it("ignores co-edit partners below minCoEditCount", () => {
    const links = linkTestsToSources(
      [file("src/weird.test.ts", "test"), file("src/engine.ts", "source")],
      [pair("src/weird.test.ts", "src/engine.ts", 1)],
      { minCoEditCount: 2 },
    );
    expect(links).toEqual([]);
  });

  it("ignores a co-edit partner that is itself a test file", () => {
    const links = linkTestsToSources(
      [
        file("src/weird.test.ts", "test"),
        file("src/helper.test.ts", "test"),
      ],
      [pair("src/weird.test.ts", "src/helper.test.ts", 5)],
    );
    expect(links).toEqual([]);
  });
});

describe("testCoverageCountMetrics", () => {
  it("emits linked_test_count per covered source", () => {
    const metrics = testCoverageCountMetrics([
      { testId: "a.test.ts", sourceId: "a.ts", method: "path" },
      { testId: "a2.test.ts", sourceId: "a.ts", method: "coedit" },
      { testId: "b.test.ts", sourceId: "b.ts", method: "path" },
    ]);
    expect(metrics).toContainEqual({
      nodeId: "a.ts",
      name: "linked_test_count",
      value: 2,
      unit: "count",
    });
    expect(metrics).toContainEqual({
      nodeId: "b.ts",
      name: "linked_test_count",
      value: 1,
      unit: "count",
    });
  });

  it("counts a (test, source) pair once even if duplicated", () => {
    const metrics = testCoverageCountMetrics([
      { testId: "a.test.ts", sourceId: "a.ts", method: "path" },
      { testId: "a.test.ts", sourceId: "a.ts", method: "path" },
    ]);
    expect(metrics).toEqual([
      { nodeId: "a.ts", name: "linked_test_count", value: 1, unit: "count" },
    ]);
  });
});
