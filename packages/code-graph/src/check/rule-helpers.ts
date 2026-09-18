import type { GraphEdge } from "../types.js";
import type { CheckRule, Severity } from "./types.js";

export function severityOf(rule: CheckRule): Severity {
  return rule.severity ?? "error";
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
}

export function isImportEdge(edge: GraphEdge): boolean {
  return edge.kind === "imports" || edge.kind === "re-exports";
}

/** Maps an id to the longest prefix it sits under, so a nested package wins over its parent. */
export function longestPrefixMatcher(prefixes: readonly string[]): (id: string) => string | null {
  const byLength = [...prefixes].sort((a, b) => b.length - a.length);
  return (id) => {
    for (const p of byLength) {
      if (id === p || id.startsWith(`${p}/`)) return p;
    }
    return null;
  };
}
