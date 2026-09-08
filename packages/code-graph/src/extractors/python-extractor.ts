import * as path from "node:path";
import { existsSync } from "node:fs";
import type { Node } from "web-tree-sitter";
import type { Extractor, ParsedFile } from "../parser/index.js";
import { collectDeclaredSpans } from "../declared-names.js";
import { buildFileModuleNodes } from "./file-nodes.js";
import { externalId, fileId, symbolId } from "./ids.js";
import { inRepoFileId } from "./module-resolution.js";
import type { GraphEdge, GraphFragment, GraphNode } from "../types.js";

/** `.py` candidates a dotted module path may resolve to, package `__init__` included. */
function* candidates(base: string): Iterable<string> {
  yield `${base}.py`;
  yield path.join(base, "__init__.py");
}

/**
 * Tree-sitter Python extraction. Deliberately narrower than the ts-morph side:
 * no type checker, so imports resolve by dotted path against the tree rather
 * than by symbol resolution, and symbols are the declarations the same
 * tree-sitter walk already finds for complexity. Enough to place Python files in
 * the graph with their dependencies; a semantic Python layer is a follow-up.
 */
export class PythonGraphExtractor implements Extractor<GraphFragment> {
  readonly name = "python-graph";

  constructor(private readonly repoRoot: string) {}

  extract(file: ParsedFile): GraphFragment[] {
    if (file.language !== "python") return [];
    const fId = fileId(this.repoRoot, file.filePath);
    const nodes = buildFileModuleNodes(this.repoRoot, file.filePath);
    nodes.push(...symbolNodes(fId, file));
    const { edges, externals } = this.collectImports(fId, file);
    return [{ nodes: [...nodes, ...externals], edges }];
  }

  private collectImports(
    srcId: string,
    file: ParsedFile,
  ): { edges: GraphEdge[]; externals: GraphNode[] } {
    const edges = new Map<string, GraphEdge>();
    const externals: GraphNode[] = [];
    for (const specifier of importSpecifiers(file.tree.rootNode)) {
      const internal = this.resolveDotted(file.filePath, specifier);
      const dstId = internal ?? externalId(specifier);
      if (!internal && !edges.has(dstId)) {
        externals.push({ id: dstId, kind: "external", name: specifier });
      }
      edges.set(dstId, { srcId, dstId, kind: "imports", attrs: { specifier, weight: 1 } });
    }
    return { edges: [...edges.values()], externals };
  }

  /**
   * Resolve `a.b.c` (or a leading-dot relative import) to an in-repo file id by
   * walking the dotted path from the importing file's package and then from the
   * repo root, which covers both intra-package and root-relative layouts.
   */
  private resolveDotted(fromAbs: string, specifier: string): string | null {
    const leadingDots = /^\.*/.exec(specifier)?.[0].length ?? 0;
    const parts = specifier.slice(leadingDots).split(".").filter(Boolean);
    const relativeBase = path.resolve(path.dirname(fromAbs), "../".repeat(Math.max(leadingDots - 1, 0)));
    const roots = leadingDots > 0 ? [relativeBase] : [path.dirname(fromAbs), this.repoRoot];
    for (const root of roots) {
      for (const candidate of candidates(path.join(root, ...parts))) {
        const id = inRepoFileId(this.repoRoot, candidate);
        if (id !== null && existsSync(candidate)) return id;
      }
    }
    return null;
  }
}

function symbolNodes(fId: string, file: ParsedFile): GraphNode[] {
  return [...collectDeclaredSpans(file)].map(([name, span]) => ({
    id: symbolId(fId, name),
    kind: "symbol" as const,
    name,
    parentId: fId,
    language: "python",
    attrs: { exported: !name.startsWith("_"), startLine: span.startLine, endLine: span.endLine },
  }));
}

/** Every module named by an `import x` / `from x import y` statement, in tree order. */
function importSpecifiers(root: Node): string[] {
  const out: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === "import_statement" || node.type === "import_from_statement") {
      const name = node.childForFieldName("module_name");
      if (name) out.push(name.text);
      else for (const child of node.namedChildren) if (child?.type === "dotted_name") out.push(child.text);
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return out;
}
