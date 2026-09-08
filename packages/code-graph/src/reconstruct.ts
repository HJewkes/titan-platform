import type { ParsedFile } from "./parser/index.js";
import { buildFileModuleNodes } from "./extractors/file-nodes.js";
import { collectDeclaredSpans, type LineSpan } from "./declared-names.js";
import type { ReuseBasis } from "./incremental.js";
import type { GraphFragment, GraphNode } from "./types.js";

/**
 * Rebuild an unchanged file's graph fragment from the prior snapshot. Produces
 * byte-for-byte the same nodes and edges the extractor would emit: file +
 * module nodes (path-derived), the symbol nodes it declares (content-derived,
 * so carried forward from the basis rather than rebuilt — C-53), the external
 * nodes its imports reference, and the outbound edges carried forward verbatim.
 */
export function reconstructFragment(
  repoRoot: string,
  absPath: string,
  fileId: string,
  basis: ReuseBasis,
): GraphFragment {
  const nodes = buildFileModuleNodes(repoRoot, absPath);
  nodes.push(...(basis.symbolsByFile.get(fileId) ?? []));
  const edges = basis.edgesBySrc.get(fileId) ?? [];
  const seenExternals = new Set<string>();
  for (const edge of edges) {
    const dst = basis.nodesById.get(edge.dstId);
    if (dst?.kind === "external" && !seenExternals.has(dst.id)) {
      seenExternals.add(dst.id);
      nodes.push({ id: dst.id, kind: "external", name: dst.name });
    }
  }
  return { nodes, edges };
}

/**
 * Reconstruct a COSMETIC file's fragment (C-18): its edges + file/module/external
 * nodes are structure-invariant so they come from the basis verbatim, but its
 * symbol line spans shifted with the moved comments/whitespace, so those are
 * refreshed from the fresh parse. Produces byte-for-byte what a full extract
 * would — same names, same `exported`, same edges — with up-to-date spans, while
 * skipping the ts-morph extract entirely. Its loc + AST metrics are recomputed
 * from the same parse by the normal metrics path.
 */
export function reconstructCosmetic(
  repoRoot: string,
  absPath: string,
  fileId: string,
  basis: ReuseBasis,
  parsed: ParsedFile,
): GraphFragment {
  const base = reconstructFragment(repoRoot, absPath, fileId, basis);
  const spans = collectDeclaredSpans(parsed);
  const nodes = base.nodes.map((n) =>
    n.kind === "symbol" ? withRefreshedSpan(n, spans) : n,
  );
  return { nodes, edges: base.edges };
}

/**
 * A symbol node with its line span refreshed from a fresh parse. Span-less
 * symbols (exported types/consts, which never carry startLine) are returned
 * unchanged; a function/method/class symbol takes the freshly-parsed span for
 * its name, matching exactly what the extractor would emit.
 */
function withRefreshedSpan(
  node: GraphNode,
  spans: ReadonlyMap<string, LineSpan>,
): GraphNode {
  const attrs = node.attrs as
    | { exported?: boolean; startLine?: number; endLine?: number }
    | undefined;
  if (!attrs || attrs.startLine === undefined) return node;
  const span = spans.get(node.name);
  if (!span) return node;
  return {
    ...node,
    attrs: { ...attrs, startLine: span.startLine, endLine: span.endLine },
  };
}
