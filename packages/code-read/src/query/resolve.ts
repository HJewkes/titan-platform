import type { CommandArgs, CommandResult } from "./contract.js";
import { modelFor } from "./snapshot-ref.js";
import { invalidArgs, type ReadSource } from "./source.js";
import { treeFor, type Tree, type TreeNode } from "./tree.js";

type Candidate = CommandResult<"node.resolve">["candidates"][number];
type Scored = { score: number; match: string };

const SEARCHED_KINDS = new Set(["directory", "file", "symbol"]);
const PATH_LINE = /^([^#]+):(\d+)$/;

// Ported from codewatch packages/cli/src/read-api/search.ts (rankSearch): exact, suffix, prefix, then substring.
function scoreNode(node: TreeNode, q: string): Scored | null {
  const id = (node.ref.kind === "directory" ? node.ref.path : node.ref.id).toLowerCase();
  const name = node.ref.name.toLowerCase();
  if (id === q || name === q) return { score: 100, match: "exact" };
  if (id.endsWith(`/${q}`) || id.endsWith(`#${q}`)) return { score: 80, match: "suffix" };
  // Since TP-182 a method's name is `Class.method`, so its bare name is a suffix of the qualified one.
  if (node.ref.kind === "symbol" && name.endsWith(`.${q}`)) return { score: 80, match: "suffix" };
  if (name.startsWith(q)) return { score: 60, match: "prefix" };
  if (id.includes(q)) return { score: 40, match: "substring" };
  if (name.includes(q)) return { score: 30, match: "substring" };
  return null;
}

function normalize(query: string): string {
  const q = query.toLowerCase();
  return q.length > 1 && q.endsWith("/") ? q.slice(0, -1) : q;
}

function rank(tree: Tree, query: string, kinds: ReadonlySet<string>): Candidate[] {
  const q = normalize(query);
  const hits: Candidate[] = [];
  for (const node of tree.byId.values()) {
    if (!kinds.has(node.ref.kind)) continue;
    const scored = scoreNode(node, q);
    if (scored) hits.push({ node: node.ref, ...scored });
  }
  return hits.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
}

// Ported from codewatch packages/graph/src/coverage.ts (innermostContaining): the smallest span holding the line.
function innermostContaining(file: TreeNode, line: number): TreeNode | null {
  let best: TreeNode | null = null;
  const visit = (node: TreeNode): void => {
    for (const child of node.children) {
      const span = child.ref.span;
      if (span && span.startLine <= line && line <= span.endLine) {
        const bestSpan = best?.ref.span;
        if (!bestSpan || span.endLine - span.startLine < bestSpan.endLine - bestSpan.startLine) best = child;
      }
      visit(child);
    }
  };
  visit(file);
  return best;
}

function resolvePath(tree: Tree, path: string, line: number | undefined): Candidate[] {
  const files = rank(tree, path, new Set(["file"]));
  if (line === undefined) return files;
  return files.map((hit) => {
    const symbol = innermostContaining(tree.byId.get(hit.node.id)!, line);
    return symbol ? { node: symbol.ref, score: hit.score, match: "span" } : hit;
  });
}

function pathAndLine(args: CommandArgs<"node.resolve">): { path: string; line: number | undefined } | null {
  if (args.path !== undefined) return { path: args.path, line: args.line };
  const m = PATH_LINE.exec(args.query!);
  return m ? { path: m[1]!, line: Number(m[2]) } : null;
}

/** `node.resolve`: a path, path:line, symbol name, or qualified id to ranked candidate nodes. */
export function resolveNode(source: ReadSource, args: CommandArgs<"node.resolve">): CommandResult<"node.resolve"> {
  if ((args.query === undefined) === (args.path === undefined)) throw invalidArgs("pass exactly one of query or path");
  if (args.line !== undefined && args.path === undefined) throw invalidArgs("line needs path");
  const tree = treeFor(modelFor(source, args.snapshot));
  const located = pathAndLine(args);
  const candidates = located ? resolvePath(tree, located.path, located.line) : rank(tree, args.query!, SEARCHED_KINDS);
  return { candidates: candidates.slice(0, args.limit) };
}
