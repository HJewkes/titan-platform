import type { GraphEdge } from "../types.js";
import type { RuleContext } from "./context.js";
import { compilePatterns, matchesAny } from "./patterns.js";
import { isImportEdge, longestPrefixMatcher, severityOf } from "./rule-helpers.js";
import type {
  CheckViolation,
  ForbidImportRule,
  LayeredDepsRule,
  NoInternalOnlyBarrelsRule,
} from "./types.js";

function layerIndex(layers: readonly string[][]): Map<string, number> {
  const packageLayer = new Map<string, number>();
  for (let i = 0; i < layers.length; i++) {
    for (const pkg of layers[i]!) packageLayer.set(pkg, i);
  }
  return packageLayer;
}

/** Layer strings are path prefixes such as `packages/cli`; an edge may only point to its own layer or a lower one. */
export function runLayeredDepsRule(rule: LayeredDepsRule, ctx: RuleContext): CheckViolation[] {
  const packageLayer = layerIndex(rule.layers);
  const packageOf = longestPrefixMatcher([...packageLayer.keys()]);
  const out: CheckViolation[] = [];
  for (const edge of ctx.edges) {
    if (!isImportEdge(edge)) continue;
    const srcPkg = packageOf(edge.srcId);
    const dstPkg = packageOf(edge.dstId);
    if (srcPkg === null || dstPkg === null) continue;
    const srcLayer = packageLayer.get(srcPkg)!;
    const dstLayer = packageLayer.get(dstPkg)!;
    if (srcLayer >= dstLayer) continue;
    out.push({
      ruleId: rule.id,
      severity: severityOf(rule),
      nodeId: edge.srcId,
      destinationId: edge.dstId,
      message: `${srcPkg} (layer ${srcLayer}) imports ${dstPkg} (layer ${dstLayer})`,
    });
  }
  return out;
}

export function runForbidImportRule(rule: ForbidImportRule, ctx: RuleContext): CheckViolation[] {
  const fromRx = compilePatterns([rule.from]);
  const toRx = compilePatterns([rule.to]);
  const out: CheckViolation[] = [];
  for (const edge of ctx.edges) {
    if (!isImportEdge(edge)) continue;
    if (!matchesAny(edge.srcId, fromRx)) continue;
    if (!matchesAny(edge.dstId, toRx)) continue;
    out.push({
      ruleId: rule.id,
      severity: severityOf(rule),
      nodeId: edge.srcId,
      destinationId: edge.dstId,
      message: `${edge.srcId} imports ${edge.dstId} (forbidden: ${rule.from} → ${rule.to})`,
    });
  }
  return out;
}

function importersByDestination(edges: readonly GraphEdge[]): Map<string, string[]> {
  const importersByDst = new Map<string, string[]>();
  for (const edge of edges) {
    if (!isImportEdge(edge)) continue;
    let list = importersByDst.get(edge.dstId);
    if (!list) {
      list = [];
      importersByDst.set(edge.dstId, list);
    }
    list.push(edge.srcId);
  }
  return importersByDst;
}

export function runNoInternalOnlyBarrelsRule(
  rule: NoInternalOnlyBarrelsRule,
  ctx: RuleContext,
): CheckViolation[] {
  const packageOf = longestPrefixMatcher(rule.packageRoots);
  const excluders = compilePatterns(rule.exclude);
  const importersByDst = importersByDestination(ctx.edges);
  const out: CheckViolation[] = [];
  for (const node of ctx.nodes) {
    if (node.kind !== "file") continue;
    if (node.role !== "barrel") continue;
    if (matchesAny(node.id, excluders)) continue;
    const barrelPkg = packageOf(node.id);
    if (barrelPkg === null) continue;
    const importers = importersByDst.get(node.id) ?? [];
    const externalCount = importers.reduce((n, src) => (packageOf(src) !== barrelPkg ? n + 1 : n), 0);
    if (externalCount > 0) continue;
    out.push({
      ruleId: rule.id,
      severity: severityOf(rule),
      nodeId: node.id,
      message: barrelMessage(barrelPkg, importers.length),
    });
  }
  return out;
}

function barrelMessage(barrelPkg: string, importerCount: number): string {
  return importerCount === 0
    ? `barrel in package "${barrelPkg}" has no importers`
    : `barrel in package "${barrelPkg}" has ${importerCount} internal importer(s) but zero external`;
}
