import { describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/rpc-protocol";
import { answer, file, memorySource, snapshotInfo, symbol } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";

type Candidates = CommandResult<"node.resolve">["candidates"];

function resolverOver(nodes: Parameters<typeof memorySource>[0][number]["nodes"]) {
  const resolve = createQueryResolver(memorySource([{ info: snapshotInfo(1), nodes, metrics: [] }]));
  return { resolve, candidates: (args: unknown) => answer(resolve)<{ candidates: Candidates }>("node.resolve", args).candidates };
}

// Cases ported from codewatch (feat/c88-conventions 58ea74b): read-api.test.ts and graph coverage.test.ts.
describe("node.resolve, cases ported from the original", () => {
  it("search ranks the symbol lookup", () => {
    const { candidates } = resolverOver([file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), symbol("src/a.ts", "foo", 2, 4), symbol("src/b.ts", "two"), symbol("src/c.ts", "three")]);

    const hits = candidates({ query: "foo" });

    expect(hits.some((h) => h.node.id === "src/a.ts#foo" && h.node.kind === "symbol")).toBe(true);
  });

  it("attributes a line to its containing symbol by range", () => {
    const { candidates } = resolverOver([file("src/a.ts"), symbol("src/a.ts", "foo", 1, 6), symbol("src/a.ts", "bar", 7, 11)]);

    expect(candidates({ path: "src/a.ts", line: 2 })[0]!.node.id).toBe("src/a.ts#foo");
    expect(candidates({ path: "src/a.ts", line: 8 })[0]!.node.id).toBe("src/a.ts#bar");
  });

  it("picks the innermost symbol when spans nest (method inside a class)", () => {
    const { candidates } = resolverOver([file("c.ts"), symbol("c.ts", "Klass", 1, 20), symbol("c.ts", "method", 4, 8)]);

    const [hit] = candidates({ path: "c.ts", line: 5 });

    expect(hit!.node.id).toBe("c.ts#method");
    expect(hit!.node.id).not.toBe("c.ts#Klass");
  });
});

describe("node.resolve cascade", () => {
  const { resolve, candidates } = resolverOver([
    file("src/jobs/runner.ts"), file("src/run.ts"), file("src/rerun/x.ts"), file("lib/Runner.ts"),
    symbol("src/jobs/runner.ts", "Job", 1, 6), symbol("src/jobs/runner.ts", "Job.run", 2, 5),
    symbol("src/jobs/runner.ts", "Task", 8, 16), symbol("src/jobs/runner.ts", "Task.run", 9, 15),
    symbol("src/run.ts", "runAll", 1, 3), symbol("src/run.ts", "prerun", 4, 6),
  ]);
  const ranked = (args: unknown) => candidates(args).map((c) => [c.node.id, c.score, c.match]);

  it("ranks exact, then suffix, then prefix, then substring, breaking ties by id", () => {
    const tiers = resolverOver([
      file("x.ts"), symbol("x.ts", "prerun"), symbol("x.ts", "runAll"), symbol("x.ts", "Task.run"), symbol("x.ts", "Job.run"), symbol("x.ts", "run"),
    ]);

    expect(tiers.candidates({ query: "run" }).map((c) => [c.node.id, c.score, c.match])).toEqual([
      ["x.ts#run", 100, "exact"],
      ["x.ts#Job.run", 80, "suffix"],
      ["x.ts#Task.run", 80, "suffix"],
      ["x.ts#runAll", 60, "prefix"],
      ["x.ts#prerun", 40, "substring"],
    ]);
  });

  it("matches a qualified name or a whole id exactly, case-insensitively", () => {
    expect(ranked({ query: "task.RUN" })[0]).toEqual(["src/jobs/runner.ts#Task.run", 100, "exact"]);
    expect(ranked({ query: "src/jobs/runner.ts#Job.run" })[0]).toEqual(["src/jobs/runner.ts#Job.run", 100, "exact"]);
  });

  it("finds a file by a path suffix and a directory by its path, with or without the slash", () => {
    expect(ranked({ query: "jobs/runner.ts" })[0]).toEqual(["src/jobs/runner.ts", 80, "suffix"]);
    expect(ranked({ query: "src/rerun" })[0]).toEqual(["src/rerun/", 100, "exact"]);
    expect(ranked({ query: "src/rerun/" })[0]).toEqual(["src/rerun/", 100, "exact"]);
  });

  it("reads path:line from a query and falls back to the file outside every symbol", () => {
    // A bare file name equals each matching file's name, so both files score as exact, as in the original.
    expect(ranked({ query: "runner.ts:12" })).toEqual([["lib/Runner.ts", 100, "exact"], ["src/jobs/runner.ts#Task.run", 100, "span"]]);
    expect(ranked({ query: "src/jobs/runner.ts:7" })).toEqual([["src/jobs/runner.ts", 100, "exact"]]);
  });

  it("caps candidates at the limit", () => {
    expect(candidates({ query: "run", limit: 2 })).toHaveLength(2);
  });

  it("rejects neither or both of query and path, and a line without a path, with DATAERR", () => {
    for (const args of [{}, { query: "a", path: "b" }, { query: "a", line: 3 }]) {
      expect(resolve("node.resolve", args)).toMatchObject({ ok: false, code: EXIT.DATAERR });
    }
  });
});
