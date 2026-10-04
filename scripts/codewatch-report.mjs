// codewatch-pr-report@1 (M4 A1): an advisory report built from the head and baseline dag-check already indexed.
// It carries repo paths, symbols and metrics only, because CI publishes it as a public artifact.
import { writeFileSync } from "node:fs";

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

/** Best effort: a failure logs to stderr and never reaches the caller, so dag-check's exit code holds. */
export function writeReport(file, build) {
  try {
    if (!file) throw new Error("--report needs a file path");
    writeFileSync(file, `${JSON.stringify(build(), null, 2)}\n`);
  } catch (err) {
    console.error(`codewatch-report: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function collectReport(graph, store, { snapshot, baselineSnapshot, result }, rules) {
  const baseId = baselineSnapshot?.id;
  const report = {
    schema: SCHEMA_ID,
    head: snapshot.commitHash,
    base: baselineSnapshot?.commitHash ?? null,
    indexVersion: snapshot.indexVersion,
    check: checkBlock(result),
    deltas: baseId === undefined ? [] : collectDeltas(graph, store, snapshot.id, baseId, budgets(rules)),
    exports: baseId === undefined ? [] : collectExports(graph, store, snapshot.id, baseId),
  };
  return { ...report, questions: renderQuestions(report) };
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
    .sort(byBudgetShare)
    .slice(0, DELTA_LIMIT);
}

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

function collectExports(graph, store, headId, baseId) {
  const head = symbolLayer(graph, store, headId);
  const base = symbolLayer(graph, store, baseId);
  return [...exportChanges(head, base)].sort(byImporters).slice(0, EXPORT_LIMIT);
}

function symbolLayer(graph, store, snapshotId) {
  const nodes = store.listNodes(snapshotId, { includeSymbols: true }).filter((n) => n.kind === "symbol");
  const edges = store.listEdges(snapshotId, { includeReferences: true });
  const importers = new Map();
  for (const e of edges) {
    if (e.kind !== "references") continue;
    importers.set(e.dstId, (importers.get(e.dstId) ?? new Set()).add(e.srcId));
  }
  return { symbols: new Map(nodes.map((n) => [n.id, n])), footprints: graph.computeFootprints({ nodes, edges }), importers };
}

function* exportChanges(head, base) {
  for (const node of head.symbols.values()) {
    if (!isExported(node)) continue;
    const prior = base.symbols.get(node.id);
    if (!isExported(prior)) yield exportEntry(node, "added", head);
    else if (signatureChanged(node.id, head, base)) yield exportEntry(node, "signature", head);
  }
  for (const node of base.symbols.values()) {
    if (isExported(node) && !isExported(head.symbols.get(node.id))) yield exportEntry(node, "removed", base);
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

function exportEntry(node, change, layer) {
  const users = [...(layer.importers.get(node.id) ?? [])].filter((file) => file !== node.parentId);
  return { path: node.parentId, symbol: node.name, line: node.attrs.startLine ?? null, change, importers: users.length };
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
