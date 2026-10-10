import * as path from "node:path";
import type { ParsedFile } from "@titan-design/code-parser";
import type { IndexSource } from "../index-source.js";
import { forEachDeclaration } from "../declared-names.js";
import { parseSymbolId, symbolId } from "../extractors/ids.js";
import type { GraphEdge, GraphMetric } from "../types.js";
import {
  codeKindFacts,
  importedNames,
  mainGuardCallees,
  moduleAssignedNames,
  type CodeKindFacts,
} from "./python-code-kinds.js";
import { isTestFunctionName, testKindFacts, type TestKindFacts } from "./python-test-kinds.js";
import { countShared, testsReaching } from "./test-reach.js";

/**
 * Code kinds and test kinds for Python (TP-2170): facts about code, not a policy
 * on which kinds need which tests. Two stages, because the call graph spans files.
 * {@link testKindSourceMetrics} reads one file's bytes and writes what each
 * function does by itself, so a reused file carries those rows forward.
 * {@link computeTestKindMetrics} combines them over every file's `calls` edges
 * on each index.
 */
const CODE_FACT_METRICS: readonly [string, keyof CodeKindFacts][] = [
  ["symbol_kind_parser", "parser"],
  ["symbol_kind_io", "io"],
  ["symbol_output_signal", "outputSignal"],
  ["symbol_state_writes", "stateWrites"],
  ["symbol_unlisted_calls", "unlistedCalls"],
];

const TEST_FACT_METRICS: readonly [string, keyof TestKindFacts][] = [
  ["test_kind_snapshot", "snapshot"],
  ["test_kind_exact_output", "exactOutput"],
  ["test_kind_loose_output", "looseOutput"],
  ["test_kind_error_path", "errorPath"],
  ["test_kind_property", "property"],
  ["test_kind_roundtrip", "roundtrip"],
];

/** Per-test-kind counts on a source symbol, in {@link TEST_FACT_METRICS} order. */
const TESTS_BY_KIND_METRICS: readonly string[] = [
  "symbol_tests_snapshot",
  "symbol_tests_exact_output",
  "symbol_tests_loose_output_only",
  "symbol_tests_error_path",
  "symbol_tests_property",
  "symbol_tests_roundtrip",
];

/** Source-local names, carried forward with a reused file. */
export const TEST_KIND_SOURCE_METRIC_NAMES: readonly string[] = [
  ...CODE_FACT_METRICS.map(([name]) => name),
  ...TEST_FACT_METRICS.map(([name]) => name),
];

const PY_TEST_PATH = /(?:^|\/)(?:tests?\/|test_[^/]*\.py$|[^/]*_test\.py$|conftest\.py$)/;

function flagRows<T>(nodeId: string, facts: T, table: readonly [string, keyof T][]): GraphMetric[] {
  return table.map(([name, key]) => {
    const v = facts[key];
    return { nodeId, name, value: typeof v === "number" ? v : v ? 1 : 0, unit: "count" };
  });
}

/** Local rows for one Python file: code-kind facts on source functions, test-kind facts on test functions. */
export function testKindSourceMetrics(fileId: string, file: ParsedFile, symbolNames: ReadonlySet<string>): GraphMetric[] {
  if (file.language !== "python") return [];
  const root = file.tree.rootNode;
  const imports = importedNames(root);
  const testFile = PY_TEST_PATH.test(fileId);
  const declared = new Set<string>();
  forEachDeclaration(file, (_name, qualifiedName) => declared.add(qualifiedName));
  const context = { imports, declared, moduleNames: moduleAssignedNames(root) };
  const guarded = mainGuardCallees(root);
  const out: GraphMetric[] = [];
  forEachDeclaration(file, (_name, qualifiedName, node) => {
    if (node.type !== "function_definition" || !symbolNames.has(qualifiedName)) return;
    const nodeId = symbolId(fileId, qualifiedName);
    if (testFile) {
      if (isTestFunctionName(qualifiedName)) out.push(...flagRows(nodeId, testKindFacts(node, imports), TEST_FACT_METRICS));
      return;
    }
    const facts = codeKindFacts(qualifiedName, node, context);
    if (guarded.has(qualifiedName)) facts.outputSignal = true;
    out.push(...flagRows(nodeId, facts, CODE_FACT_METRICS));
  });
  return out;
}

interface TestKindInput {
  edges: readonly GraphEdge[];
  /** Every source-local row of the snapshot, fresh and reused alike. */
  sourceMetrics: readonly GraphMetric[];
  /** Console-script targets such as `pkg.cli:main`, from {@link consoleScripts}. */
  entryPoints?: readonly string[];
}

/** Each fact row's value, keyed by metric name, then node id. */
function factsByName(rows: readonly GraphMetric[], names: readonly string[]): Map<string, Map<string, number>> {
  const out = new Map(names.map((n) => [n, new Map<string, number>()]));
  for (const row of rows) out.get(row.name)?.set(row.nodeId, row.value ?? 0);
  return out;
}

function callAdjacency(edges: Iterable<GraphEdge>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "calls" || e.srcId === e.dstId) continue;
    const list = out.get(e.srcId);
    if (list) list.push(e.dstId);
    else out.set(e.srcId, [e.dstId]);
  }
  return out;
}

/** Every node reachable from `starts` through `adjacency`, the starts included. */
function closure(starts: Iterable<string>, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set(starts);
  const queue = [...seen];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** True when `fileId` is the file a dotted module path names, under any source root (`src/` layouts included). */
function isModuleFile(fileId: string, module: string): boolean {
  const base = module.replaceAll(".", "/");
  return [`${base}.py`, `${base}/__init__.py`].some((s) => fileId === s || fileId.endsWith(`/${s}`));
}

/** Symbol ids a console script, or a module-level call in a `__main__.py`, starts. */
function entrySymbols(input: TestKindInput, sources: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const target of input.entryPoints ?? []) {
    const [module, attr] = target.split(":").map((s) => s.trim());
    if (!module || !attr) continue;
    for (const id of sources) {
      const parsed = parseSymbolId(id);
      if (parsed?.name === attr && isModuleFile(parsed.fileId, module)) out.add(id);
    }
  }
  for (const e of input.edges) {
    if (e.kind === "calls" && /(?:^|\/)__main__\.py$/.test(e.srcId)) out.add(e.dstId);
  }
  return out;
}

type Facts = Map<string, Map<string, number>>;

const value = (facts: Facts, name: string, id: string): number => facts.get(name)?.get(id) ?? 0;
const flag = (facts: Facts, name: string, id: string): boolean => value(facts, name, id) === 1;

function outputBoundaries(input: TestKindInput, facts: Facts, sources: ReadonlySet<string>): Set<string> {
  const entries = entrySymbols(input, sources);
  return new Set([...sources].filter((id) => entries.has(id) || flag(facts, "symbol_output_signal", id)));
}

/** Call sites per caller that a `calls` edge resolved, recursion included. */
function resolvedSites(edges: readonly GraphEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of edges) {
    if (e.kind !== "calls") continue;
    const recorded = e.attrs?.sites;
    const sites = Array.isArray(recorded) ? recorded.length : 1;
    out.set(e.srcId, (out.get(e.srcId) ?? 0) + sites);
  }
  return out;
}

/**
 * Symbols whose own effects rule out purity: I/O, output, a write to state they do not own, a call the
 * graph did not resolve and the allow-list does not cover, or a resolved call to anything but a source function.
 */
function effectfulSymbols(edges: readonly GraphEdge[], facts: Facts, sources: ReadonlySet<string>, boundary: ReadonlySet<string>): string[] {
  const resolved = resolvedSites(edges);
  const callees = callAdjacency(edges);
  return [...sources].filter(
    (id) =>
      boundary.has(id) ||
      flag(facts, "symbol_kind_io", id) ||
      flag(facts, "symbol_state_writes", id) ||
      value(facts, "symbol_unlisted_calls", id) > (resolved.get(id) ?? 0) ||
      (callees.get(id) ?? []).some((callee) => !sources.has(callee)),
  );
}

function codeKindRows(input: TestKindInput, facts: Facts, sources: ReadonlySet<string>, boundary: ReadonlySet<string>): GraphMetric[] {
  const callers = callAdjacency(input.edges.map((e) => ({ ...e, srcId: e.dstId, dstId: e.srcId })));
  const impure = closure(effectfulSymbols(input.edges, facts, sources, boundary), callers);
  return [...sources].flatMap((nodeId) => {
    const pure = !impure.has(nodeId) && !flag(facts, "symbol_kind_parser", nodeId);
    return [
      { nodeId, name: "symbol_kind_output_boundary", value: boundary.has(nodeId) ? 1 : 0, unit: "count" },
      { nodeId, name: "symbol_kind_pure", value: pure ? 1 : 0, unit: "count" },
    ];
  });
}

/** Bitsets over `tests` of those with each test kind, in {@link TEST_FACT_METRICS} order. */
function kindMasks(facts: Facts, tests: readonly string[]): Uint32Array[] {
  return TEST_FACT_METRICS.map(([name]) => {
    const mask = new Uint32Array(Math.ceil(tests.length / 32));
    tests.forEach((id, i) => {
      if (flag(facts, name, id)) mask[i >>> 5]! |= 1 << (i & 31);
    });
    return mask;
  });
}

/**
 * Per source symbol, the tests of each kind that reach it through `calls` edges; written only where at least
 * one test does. A test is credited only to what it actually reaches.
 */
function testCountRows(input: TestKindInput, facts: Facts, sources: ReadonlySet<string>): GraphMetric[] {
  const tests = [...facts.get(TEST_FACT_METRICS[0]![0])!.keys()];
  if (tests.length === 0) return [];
  const reaching = testsReaching(callAdjacency(input.edges), tests);
  const masks = kindMasks(facts, tests);
  return [...sources].flatMap((nodeId) => {
    const bits = reaching.get(nodeId);
    if (!bits) return [];
    return TESTS_BY_KIND_METRICS.map((name, k) => ({ nodeId, name, value: countShared(bits, masks[k]!), unit: "count" }));
  });
}

/** Graph-wide code kinds and per-kind test counts over every Python function's local facts. */
export function computeTestKindMetrics(input: TestKindInput): GraphMetric[] {
  const facts = factsByName(input.sourceMetrics, TEST_KIND_SOURCE_METRIC_NAMES);
  const sources = new Set(facts.get("symbol_kind_io")!.keys());
  if (sources.size === 0) return [];
  const boundary = outputBoundaries(input, facts, sources);
  return [...codeKindRows(input, facts, sources, boundary), ...testCountRows(input, facts, sources)];
}

const SCRIPT_SECTIONS = new Set(["[project.scripts]", "[tool.poetry.scripts]"]);

/** `module:attr` targets of the console scripts a `pyproject.toml` declares. */
export function consoleScripts(pyproject: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const raw of pyproject.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) inSection = SCRIPT_SECTIONS.has(line);
    const target = inSection ? /^[\w.-]+\s*=\s*["']([\w.]+:[\w.]+)["']/.exec(line)?.[1] : undefined;
    if (target) out.push(target);
  }
  return out;
}

/** Console scripts from the `pyproject.toml` in each of `dirs`, the repo root and the indexed roots. */
export function loadEntryPoints(
  dirs: readonly string[],
  source: Pick<IndexSource, "fileExists" | "readFile">,
): string[] {
  const files = [...new Set(dirs.map((d) => path.join(d, "pyproject.toml")))];
  return files.filter((f) => source.fileExists(f)).flatMap((f) => consoleScripts(source.readFile(f)));
}
