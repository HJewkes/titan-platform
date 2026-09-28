import type { GraphNode } from "../types.js";
import type { CheckViolation } from "./types.js";

export const CODE_GRAPH_TOOL = "code-graph";

export type ViolationLocation = Pick<CheckViolation, "path" | "lineStart" | "lineEnd" | "symbol">;

/** Where a node lives in the source: a symbol points at its parent file and its own line span. */
export function locateNode(node: GraphNode): ViolationLocation {
  if (node.kind !== "symbol") return { path: node.id };
  const location: ViolationLocation = { path: node.parentId ?? node.id, symbol: node.name };
  const startLine = node.attrs?.startLine;
  const endLine = node.attrs?.endLine;
  if (typeof startLine === "number") location.lineStart = startLine;
  if (typeof endLine === "number") location.lineEnd = endLine;
  return location;
}
