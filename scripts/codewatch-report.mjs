// codewatch-pr-report@1 (M4 A1): an advisory report built from the head and baseline dag-check already indexed.
// It carries repo paths, symbols and metrics only, because CI publishes it as a public artifact.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./codewatch-metrics.mjs";

export const SCHEMA_ID = "codewatch-pr-report@1";
const DELTA_LIMIT = 20;
const EXPORT_LIMIT = 10;
const QUESTION_LIMIT = 3;
const QUESTION_MAX_CHARS = 200;
const NEAR_BUDGET_RATIO = 0.8;
const NEW_FILE_LOC = 250;
// Report metric name to the file-level metric the indexer stores.
const STORED_METRIC = { loc: "loc", cyclomatic_max: "cyclomatic_max", cognitive: "cognitive_max", max_nesting_depth: "max_nesting_depth" };
const REPORT_METRIC = new Map(Object.entries(STORED_METRIC).map(([report, stored]) => [stored, report]));
// Budgets in check.json exclude these roles, so their metrics would only add noise.
const SKIPPED_ROLES = new Set(["test", "fixture"]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Best effort: a failure logs to stderr and never reaches the caller, so dag-check's exit code holds. */
export function writeReport(file, build) {
  try {
    if (!file) throw new Error("--report needs a file path");
    writeFileSync(file, `${JSON.stringify(build(), null, 2)}\n`);
  } catch (err) {
    console.error(`codewatch-report: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Questions come from every row; the top-N cut applies only to the deltas and exports tables. */
export function collectReport(graph, store, { snapshot, baselineSnapshot, result }, rules, options = {}) {
  const baseId = baselineSnapshot?.id;
  const base = baselineSnapshot?.commitHash ?? null;
  const lineOf = declarationLines(options.readSource ?? gitSource(base));
  const full = {
    schema: SCHEMA_ID,
    head: snapshot.commitHash,
    base,
    indexVersion: snapshot.indexVersion,
    check: checkBlock(result),
    deltas: baseId === undefined ? [] : collectDeltas(graph, store, snapshot.id, baseId, budgets(rules)),
    exports: baseId === undefined ? [] : collectExports(graph, store, snapshot.id, baseId, lineOf),
  };
  const questions = renderQuestions(full);
  return { ...full, deltas: full.deltas.slice(0, DELTA_LIMIT), exports: full.exports.slice(0, EXPORT_LIMIT), questions };
}

function checkBlock(result) {
  return {
    passed: result.passed,
    newErrors: result.newErrors,
    newWarnings: result.newWarnings,
    carryover: (result.carryoverErrors ?? 0) + (result.carryoverWarnings ?? 0),
    violations: result.violations.map((v) => ({
      ruleId: v.ruleId,
      severity: v.severity,
      nodeId: v.nodeId,
      path: v.path ?? v.nodeId,
      line: v.lineStart ?? null,
      message: v.message,
      isCarryover: v.isCarryover === true,
    })),
  };
}

function budgets(rules) {
  const byMetric = new Map();
  for (const rule of rules) {
    const metric = REPORT_METRIC.get(rule.metric);
    if (rule.type === "metric-max" && rule.kind === "file" && metric) byMetric.set(metric, rule.max);
  }
  return byMetric;
}

function collectDeltas(graph, store, headId, baseId, budgetByMetric) {
  const diff = graph.diffSnapshots(store, { fromSnapshotId: baseId, toSnapshotId: headId });
  const sourceFiles = new Set(store.listNodes(headId).filter(isSourceFile).map((n) => n.id));
  const added = new Set(diff.addedNodes.filter((n) => sourceFiles.has(n.id)).map((n) => n.id));
  const changed = diff.metricDeltas.map((d) => ({ ...d, isNewFile: false }));
  const fresh = store.listMetrics(headId).filter((m) => added.has(m.nodeId));
  const changes = [...changed, ...fresh.map((m) => ({ nodeId: m.nodeId, name: m.name, before: null, after: m.value, isNewFile: true }))];
  return changes
    .filter((c) => sourceFiles.has(c.nodeId) && REPORT_METRIC.has(c.name) && c.after !== null)
    .map((c) => classify(c, budgetByMetric.get(REPORT_METRIC.get(c.name)) ?? null))
    .filter((d) => d !== null)
    .sort(byBudgetShare);
}

// The role is the indexer's classifyRole answer, which covers *.fixture.* files as well as fixtures/ directories.
function isSourceFile(node) {
  return node.kind === "file" && !SKIPPED_ROLES.has(node.role);
}

function classify(change, budget) {
  const metric = REPORT_METRIC.get(change.name);
  const status = deltaStatus({ ...change, metric }, budget);
  if (!status) return null;
  return { path: change.nodeId, symbol: null, metric, before: change.before, after: change.after, budget, status };
}

function deltaStatus({ metric, before, after, isNewFile }, budget) {
  const nearBudget = (value) => budget !== null && value !== null && value >= budget * NEAR_BUDGET_RATIO;
  if (nearBudget(after) && !nearBudget(before)) return "near-budget";
  if (isNewFile) return metric === "loc" && after > NEW_FILE_LOC ? "new" : null;
  return before !== null && after > before ? "worsened" : null;
}

function byBudgetShare(a, b) {
  const share = (d) => (d.budget ? d.after / d.budget : 0);
  return share(b) - share(a) || compare(a.path, b.path) || compare(a.metric, b.metric);
}

function collectExports(graph, store, headId, baseId, lineOf) {
  const head = symbolLayer(graph, store, headId, "head");
  const base = symbolLayer(graph, store, baseId, "base");
  return [...exportChanges(head, base, lineOf)].sort(byImporters);
}

function symbolLayer(graph, store, snapshotId, side) {
  const nodes = store.listNodes(snapshotId, { includeSymbols: true }).filter((n) => n.kind === "symbol");
  const edges = store.listEdges(snapshotId, { includeReferences: true });
  const importers = new Map();
  for (const e of edges) {
    if (e.kind !== "references") continue;
    importers.set(e.dstId, (importers.get(e.dstId) ?? new Set()).add(e.srcId));
  }
  return { side, symbols: new Map(nodes.map((n) => [n.id, n])), footprints: graph.computeFootprints({ nodes, edges }), importers };
}

function* exportChanges(head, base, lineOf) {
  for (const node of head.symbols.values()) {
    if (!isExported(node)) continue;
    const prior = base.symbols.get(node.id);
    if (!isExported(prior)) yield exportEntry(node, "added", head, lineOf);
    else if (signatureChanged(node.id, head, base)) yield exportEntry(node, "signature", head, lineOf);
  }
  for (const node of base.symbols.values()) {
    if (isExported(node) && !isExported(head.symbols.get(node.id))) yield exportEntry(node, "removed", base, lineOf);
  }
}

function isExported(node) {
  return node?.attrs?.exported === true;
}

// The footprint's signature part also hashes the doc comment; a doc-only edit is not an API change.
function signatureChanged(id, head, base) {
  const footprintMoved = head.footprints.get(id)?.parts.signature !== base.footprints.get(id)?.parts.signature;
  return footprintMoved && head.symbols.get(id).attrs.signature !== base.symbols.get(id).attrs.signature;
}

function exportEntry(node, change, layer, lineOf) {
  const users = [...(layer.importers.get(node.id) ?? [])].filter((file) => file !== node.parentId);
  const line = node.attrs.startLine ?? lineOf(layer.side, node.parentId, node.name);
  return { path: node.parentId, symbol: node.name, line, change, importers: users.length };
}

// The indexer records spans for functions and classes only, so types, interfaces and consts are found in the source text.
function declarationLines(readSource) {
  const texts = new Map();
  return (side, file, name) => {
    const key = `${side}:${file}`;
    if (!texts.has(key)) texts.set(key, readSource(side, file)?.split("\n") ?? []);
    return firstLine(texts.get(key), declarationPattern(name)) ?? firstLine(texts.get(key), exportPattern(name));
  };
}

function firstLine(lines, pattern) {
  const index = lines.findIndex((text) => pattern.test(text));
  return index < 0 ? null : index + 1;
}

// Fallback for destructured consts and export lists: the export statement that names the symbol.
function exportPattern(name) {
  return new RegExp(`^\\s*export\\b.*(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
}

function declarationPattern(name) {
  const modifiers = "(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?";
  const keyword = "(?:const\\s+enum|type|interface|enum|const|let|var|class|function\\*?|namespace)";
  return new RegExp(`^\\s*${modifiers}${keyword}\\s+${escapeRegExp(name)}\\b`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Head is the indexed working tree; base is read from git at the baseline commit. A missing file reads as null. */
function gitSource(baseCommit) {
  return (side, file) => {
    try {
      if (side === "head") return readFileSync(path.join(ROOT, file), "utf8");
      if (!baseCommit) return null;
      return execFileSync("git", ["show", `${baseCommit}:${file}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
}

function byImporters(a, b) {
  return b.importers - a.importers || compare(a.path, b.path) || compare(a.symbol, b.symbol);
}

/** Up to three reviewer questions, in a fixed order: new violations, then budget deltas, then broken exports. */
export function renderQuestions(report) {
  const newViolations = report.check.violations.filter((v) => !v.isCarryover).sort(byLocation);
  const candidates = [
    ...newViolations.map(violationQuestion),
    ...report.deltas.filter((d) => d.status !== "worsened").map(deltaQuestion),
    ...report.exports.filter((e) => e.change !== "added" && e.importers > 0).map(exportQuestion),
  ];
  return candidates.slice(0, QUESTION_LIMIT).map(clip);
}

function byLocation(a, b) {
  return compare(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || compare(a.ruleId, b.ruleId);
}

function violationQuestion(v) {
  return `${v.path}:${v.line ?? 1} breaks ${v.ruleId} (new ${v.severity}): does this belong here, or should the code move?`;
}

function deltaQuestion(d) {
  if (d.status === "new") return `${d.path}:1 is a new ${d.after}-line file: does it hold one responsibility, or should it start split?`;
  const was = d.before === null ? "" : `, was ${d.before}`;
  return `${d.path}:1 ${d.metric} is ${d.after} against a budget of ${d.budget}${was}: should it be split before it crosses?`;
}

function exportQuestion(e) {
  const what = e.change === "removed" ? `removes export ${e.symbol}` : `changes the signature of export ${e.symbol}`;
  return `${e.path}:${e.line ?? 1} ${what}, imported by ${e.importers} file(s): are they all updated in this PR?`;
}

function clip(text) {
  return text.length <= QUESTION_MAX_CHARS ? text : `${text.slice(0, QUESTION_MAX_CHARS - 1)}…`;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The PR report is written through dag-check-self.mjs; the command line serves the full-tree mode.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
