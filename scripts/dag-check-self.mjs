#!/usr/bin/env node
// scripts/dag-check.sh on the ported code-graph engine; BASE_REF marks existing violations carryover, --json prints the result, exit 0/1/2 as codewatch.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, ".codewatch/check.json");
const ENTRY = path.join(ROOT, "packages/code-graph/dist/index.js");

async function indexTree(graph, store, dir, ref) {
  const paths = [path.join(dir, "packages"), path.join(dir, "products")];
  const r = await graph.indexPaths(store, { paths, ref, computeChurn: false });
  console.error(`indexed ${ref}: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges -> snapshot ${r.snapshotId}`);
}

function git(...args) {
  execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

async function indexBaseline(graph, store, workDir, baseRef) {
  const dir = path.join(workDir, "baseline");
  git("worktree", "prune");
  git("worktree", "add", "--detach", dir, baseRef);
  try {
    await indexTree(graph, store, dir, "baseline");
  } finally {
    git("worktree", "remove", "--force", dir);
  }
}

function groupByRule(violations) {
  const grouped = new Map();
  for (const v of violations) grouped.set(v.ruleId, [...(grouped.get(v.ruleId) ?? []), v]);
  return grouped;
}

function violationLine(v) {
  const severity = v.severity === "error" ? "ERROR  " : "WARN   ";
  return `  ${v.isCarryover ? "CARRY " : ""}${severity}${v.nodeId}  ${v.message}`;
}

function statusLine(result, hasBaseline) {
  if (!hasBaseline) {
    return result.passed
      ? `${result.newWarnings} warning(s) — passed.`
      : `${result.newErrors} error(s), ${result.newWarnings} warning(s) — failed.`;
  }
  const carry = `${result.carryoverErrors + result.carryoverWarnings} carryover`;
  return result.passed
    ? `✓ no new violations (${result.newWarnings} new warning(s), ${carry}).`
    : `${result.newErrors} new error(s), ${result.newWarnings} new warning(s), ${carry} — failed.`;
}

function formatText({ snapshot, baselineSnapshot, result }) {
  const base = baselineSnapshot ? ` vs baseline snap ${baselineSnapshot.id} (${baselineSnapshot.ref})` : "";
  const lines = [`Graph check: snap ${snapshot.id} (${snapshot.ref})${base} — ${CONFIG}`, ""];
  if (result.violations.length === 0) {
    lines.push(`✓ ${result.rulesEvaluated} rule(s) passed across ${result.nodesEvaluated} node(s).`);
    return lines.join("\n");
  }
  for (const [ruleId, list] of groupByRule(result.violations)) {
    const carried = list.filter((v) => v.isCarryover).length;
    lines.push(baselineSnapshot ? `${ruleId} (${list.length - carried} new, ${carried} carryover)` : `${ruleId} (${list.length})`);
    lines.push(...list.map(violationLine), "");
  }
  lines.push(statusLine(result, !!baselineSnapshot));
  return lines.join("\n");
}

async function main() {
  if (!existsSync(ENTRY)) {
    console.error(`${ENTRY} not found; run pnpm build first`);
    return 2;
  }
  const graph = await import(ENTRY);
  const baseRef = process.env.BASE_REF;
  const workDir = mkdtempSync(path.join(tmpdir(), "dag-check-self-"));
  const store = graph.openCodeGraph(path.join(workDir, "graph.db"));
  try {
    await indexTree(graph, store, ROOT, "head");
    if (baseRef) await indexBaseline(graph, store, workDir, baseRef);
    const rules = await graph.loadCheckRules(CONFIG, { onWarn: (m) => console.warn(`${CONFIG}: ${m}`) });
    const run = graph.checkSnapshot(store, { snapshot: "head", baseline: baseRef ? "baseline" : undefined, rules });
    const json = { ...run, baselineSnapshot: run.baselineSnapshot ?? null, configPath: CONFIG };
    console.log(process.argv.includes("--json") ? JSON.stringify(json, null, 2) : formatText(run));
    return run.result.passed ? 0 : 1;
  } finally {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
