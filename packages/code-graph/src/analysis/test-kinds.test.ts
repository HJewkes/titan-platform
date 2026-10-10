import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { makeTestRepo, type TestRepo } from "../history/test-repo.js";
import { indexPaths } from "../indexer.js";
import { computeSourceMetrics } from "../source-metrics.js";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { TEST_KINDS_PROJECT } from "./test-kinds.fixture.js";
import { consoleScripts } from "./test-kinds.js";

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

describe("test kinds over an indexed Python project (TP-2170)", () => {
  let repo: TestRepo;
  let store: CodeGraphStore;
  let values: Map<string, number>;

  const metric = (symbol: string, name: string): number | undefined => values.get(`${symbol} ${name}`);
  const kinds = (symbol: string) => ({
    outputBoundary: metric(symbol, "symbol_kind_output_boundary"),
    parser: metric(symbol, "symbol_kind_parser"),
    io: metric(symbol, "symbol_kind_io"),
    pure: metric(symbol, "symbol_kind_pure"),
  });
  const tests = (symbol: string) => ({
    snapshot: metric(symbol, "symbol_tests_snapshot") ?? 0,
    exact: metric(symbol, "symbol_tests_exact_output") ?? 0,
    looseOnly: metric(symbol, "symbol_tests_loose_output_only") ?? 0,
    errorPath: metric(symbol, "symbol_tests_error_path") ?? 0,
    property: metric(symbol, "symbol_tests_property") ?? 0,
    roundtrip: metric(symbol, "symbol_tests_roundtrip") ?? 0,
  });
  const none = { snapshot: 0, exact: 0, looseOnly: 0, errorPath: 0, property: 0, roundtrip: 0 };

  beforeAll(async () => {
    repo = await makeTestRepo();
    for (const [file, contents] of Object.entries(TEST_KINDS_PROJECT)) await repo.write(file, contents);
    repo.commit("fixture");
    store = openCodeGraph(":memory:");
    const { snapshotId } = await indexPaths(store, { paths: [repo.dir] });
    const rows = store.db.prepare("SELECT node_id, name, value FROM metric WHERE snapshot_id = ?").all(snapshotId) as {
      node_id: string;
      name: string;
      value: number;
    }[];
    values = new Map(rows.map((r) => [`${r.node_id} ${r.name}`, r.value]));
  });

  afterAll(async () => {
    store.close();
    await repo.cleanup();
  });

  it("flags the CLI whose only test checks substrings as a loose-only output boundary with no snapshot", () => {
    expect(kinds("app/cli.py#main")).toEqual({ outputBoundary: 1, parser: 0, io: 0, pure: 0 });
    expect(tests("app/cli.py#main")).toEqual({ ...none, looseOnly: 1 });
  });

  it("finds output boundaries by console script, __main__ guard, route and click command", () => {
    for (const symbol of ["app/cli.py#run", "app/cli.py#guarded", "app/web.py#hello", "app/clicmd.py#greet"]) {
      expect(kinds(symbol).outputBoundary, symbol).toBe(1);
    }
    expect(kinds("app/core.py#shout").outputBoundary, "a script in another TOML section").toBe(0);
  });

  it("classifies parsers, I/O and pure logic", () => {
    expect(kinds("app/core.py#parse_config")).toEqual({ outputBoundary: 0, parser: 1, io: 0, pure: 0 });
    expect(kinds("app/core.py#load")).toMatchObject({ parser: 1, pure: 0 });
    expect(kinds("app/core.py#save")).toMatchObject({ io: 1, pure: 0 });
    expect(kinds("app/core.py#run_git")).toMatchObject({ io: 1, pure: 0 });
    for (const symbol of ["app/core.py#shout", "app/core.py#dump", "app/core.py#join_parts"]) {
      expect(kinds(symbol), symbol).toEqual({ outputBoundary: 0, parser: 0, io: 0, pure: 1 });
    }
  });

  it("reads a pathlib method as I/O only on a path, so str.replace stays pure", () => {
    expect(kinds("app/core.py#slugify")).toEqual({ outputBoundary: 0, parser: 0, io: 0, pure: 1 });
    expect(kinds("app/core.py#touch_marker")).toMatchObject({ io: 1, pure: 0 });
  });

  it("does not count a mutation of a local that shadows a module-level name as a global write", () => {
    expect(metric("app/core.py#collect", "symbol_global_writes")).toBe(0);
    expect(kinds("app/core.py#collect")).toMatchObject({ pure: 1 });
  });

  it("flags a parser method by its own name", () => {
    expect(kinds("app/core.py#Config.parse")).toMatchObject({ parser: 1 });
  });

  it("does not call a function pure when it writes globals or calls one that does I/O", () => {
    expect(metric("app/core.py#remember", "symbol_global_writes")).toBe(1);
    expect(kinds("app/core.py#remember")).toMatchObject({ io: 0, pure: 0 });
    expect(kinds("app/core.py#shout_and_save")).toMatchObject({ io: 0, pure: 0 });
  });

  it("counts the tests of each kind that reach a symbol through calls", () => {
    expect(tests("app/core.py#shout")).toEqual({ ...none, exact: 1, looseOnly: 2, property: 1 });
    expect(tests("app/core.py#parse_config")).toEqual({ ...none, errorPath: 1 });
    expect(tests("app/core.py#load")).toEqual({ ...none, roundtrip: 1 });
    expect(tests("app/core.py#dump")).toEqual({ ...none, roundtrip: 1 });
    expect(tests("app/core.py#save")).toEqual({ ...none, snapshot: 1 });
  });

  it("credits a CliRunner test to the output boundary of the source the test linker pairs it with", () => {
    expect(tests("app/clicmd.py#greet")).toEqual({ ...none, snapshot: 1, errorPath: 1 });
  });

  it("writes no test counts on a symbol no test reaches", () => {
    expect(metric("app/core.py#run_git", "symbol_tests_snapshot")).toBeUndefined();
  });
});

async function testFacts(code: string): Promise<Record<string, Record<string, number>>> {
  const file = await parseFile(code, "tests/test_x.py", "python");
  const names = new Set(["test_a", "TestCase.test_b", "helper"]);
  const out: Record<string, Record<string, number>> = {};
  for (const m of computeSourceMetrics([file], (p) => p, new Map([["tests/test_x.py", names]]))) {
    if (!m.name.startsWith("test_kind_")) continue;
    const symbol = m.nodeId.split("#")[1]!;
    (out[symbol] ??= {})[m.name.slice("test_kind_".length)] = m.value ?? 0;
  }
  return out;
}

const only = (...kinds: string[]) =>
  Object.fromEntries(
    ["snapshot", "exact_output", "loose_output", "error_path", "property", "roundtrip"].map((k) => [k, kinds.includes(k) ? 1 : 0]),
  );

describe("test-kind facts of one test function", () => {
  it("writes facts only on pytest-collected test functions", async () => {
    const facts = await testFacts(lines("def helper():", "    assert 1 == 1", "", "def test_a():", "    assert x"));
    expect(Object.keys(facts)).toEqual(["test_a"]);
  });

  it("treats an exit status of 0 as neither output nor error, and a non-zero one as an error path", async () => {
    const ok = await testFacts(lines("def test_a():", "    assert r.exit_code == 0", "    assert 'x' not in r.output"));
    expect(ok.test_a).toEqual(only("loose_output"));
    const failed = await testFacts(lines("def test_a():", "    assert r.returncode == 2"));
    expect(failed.test_a).toEqual(only("error_path"));
    const http = await testFacts(lines("def test_a():", "    assert resp.status_code == 404"));
    expect(http.test_a).toEqual(only("error_path"));
    const systemExit = await testFacts(lines("def test_a():", "    assert excinfo.value.code == 2"));
    expect(systemExit.test_a).toEqual(only("error_path"));
    const bareCode = await testFacts(lines("def test_a():", "    assert code == 3"));
    expect(bareCode.test_a).toEqual(only("exact_output"));
  });

  it("reads a file compared with an inline literal as exact output, not a golden file", async () => {
    const inline = await testFacts(lines("def test_a():", "    assert out.read_text() == 'hello\\n'"));
    expect(inline.test_a).toEqual(only("exact_output"));
    const golden = await testFacts(lines("def test_a():", "    assert out.read_text() == GOLDEN.read_text()"));
    expect(golden.test_a).toEqual(only("snapshot"));
  });

  it("reads length and shape equalities as loose, and any exact one as exact", async () => {
    const loose = await testFacts(lines("def test_a():", "    assert len(out) == 3", "    assert arr.shape == (2, 2)"));
    expect(loose.test_a).toEqual(only("loose_output"));
    const mixed = await testFacts(lines("def test_a():", "    assert 'x' in out", "    assert out == 'x\\n'"));
    expect(mixed.test_a).toEqual(only("exact_output"));
  });

  it("classifies unittest assertions on a Test class method", async () => {
    const code = lines(
      "class TestCase(unittest.TestCase):",
      "    def test_b(self):",
      "        self.assertEqual(f(1), 2)",
      "        with self.assertRaises(KeyError):",
      "            f(None)",
    );
    expect((await testFacts(code))["TestCase.test_b"]).toEqual(only("exact_output", "error_path"));
  });

  it("recognizes approvaltests verify and pytest-regressions fixtures as snapshots", async () => {
    const verify = await testFacts(lines("from approvaltests import verify", "def test_a():", "    verify(render())"));
    expect(verify.test_a).toEqual(only("snapshot"));
    const regression = await testFacts(lines("def test_a(data_regression):", "    data_regression.check(render())"));
    expect(regression.test_a).toEqual(only("snapshot"));
  });
});

describe("consoleScripts", () => {
  it("reads project and poetry scripts and skips other sections", () => {
    const toml = lines(
      "[project.scripts]",
      'a = "pkg.cli:main"',
      "[tool.poetry.scripts]",
      "b = 'pkg.other:run'",
      "[tool.ruff]",
      'c = "pkg.x:y"',
    );
    expect(consoleScripts(toml)).toEqual(["pkg.cli:main", "pkg.other:run"]);
  });
});
