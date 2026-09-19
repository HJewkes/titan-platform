import type { ModelNode, ReadModel } from "./model.js";
import type { NodeRef, Span } from "./schemas.js";

/** One row of the synthesized hierarchy: repo, directory, file, or symbol. */
export interface TreeNode {
  ref: NodeRef;
  parentId: string | null;
  /** Absolute depth: the repo is 0. */
  depth: number;
  /** The stored node; absent for the synthesized repo and directories. */
  stored?: ModelNode;
  children: TreeNode[];
}

/** code-graph stores no repo, directory, or class level, so this tree is derived from file paths and symbol scopes. */
export interface Tree {
  root: TreeNode;
  byId: ReadonlyMap<string, TreeNode>;
}

export const REPO_ID = "";
const SYMBOL_SEP = "#";

/** A directory's id carries a trailing slash, which no file id has, so the two id spaces never collide. */
export function directoryId(path: string): string {
  return path === "" ? REPO_ID : `${path}/`;
}

export function spanOf(node: ModelNode): Span | undefined {
  const { startLine, endLine } = node.attrs;
  return typeof startLine === "number" && typeof endLine === "number" ? { startLine, endLine } : undefined;
}

export function toRef(node: ModelNode): NodeRef {
  const sep = node.kind === "symbol" ? node.id.indexOf(SYMBOL_SEP) : -1;
  const ref: NodeRef = { id: node.id, kind: node.kind, name: node.name, path: sep < 0 ? node.id : node.id.slice(0, sep) };
  const span = spanOf(node);
  if (span) ref.span = span;
  return ref;
}

function treeNode(ref: NodeRef, parentId: string | null, stored?: ModelNode): TreeNode {
  return stored ? { ref, parentId, depth: 0, stored, children: [] } : { ref, parentId, depth: 0, children: [] };
}

function dirPath(fileId: string): string {
  const slash = fileId.lastIndexOf("/");
  return slash < 0 ? "" : fileId.slice(0, slash);
}

function ensureDirectory(byId: Map<string, TreeNode>, path: string): TreeNode {
  const id = directoryId(path);
  const existing = byId.get(id);
  if (existing) return existing;
  const parent = ensureDirectory(byId, dirPath(path));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dir = treeNode({ id, kind: "directory", name, path }, parent.ref.id);
  parent.children.push(dir);
  byId.set(id, dir);
  return dir;
}

function attach(byId: Map<string, TreeNode>, parent: TreeNode, stored: ModelNode): void {
  const node = treeNode(toRef(stored), parent.ref.id, stored);
  parent.children.push(node);
  byId.set(stored.id, node);
}

function containsStrictly(outer: Span, inner: Span): boolean {
  const wider = outer.endLine - outer.startLine > inner.endLine - inner.startLine;
  return wider && outer.startLine <= inner.startLine && inner.endLine <= outer.endLine;
}

/** The smallest sibling symbol whose span strictly contains this one: the class level for pre-0.14 bare-name ids. */
function innermostEnclosing(symbol: ModelNode, siblings: readonly ModelNode[]): ModelNode | undefined {
  const span = spanOf(symbol);
  if (!span) return undefined;
  let best: ModelNode | undefined;
  let bestSpan: Span | undefined;
  for (const other of siblings) {
    const outer = spanOf(other);
    if (other === symbol || !outer || !containsStrictly(outer, span)) continue;
    if (!bestSpan || outer.endLine - outer.startLine < bestSpan.endLine - bestSpan.startLine) [best, bestSpan] = [other, outer];
  }
  return best;
}

/** A qualified name `A.b.c` hangs under `A.b`, else `A`, else the symbol whose span encloses it, else its file. */
function symbolParentId(symbol: ModelNode, fileId: string, bySymbolId: ReadonlyMap<string, ModelNode>, siblings: readonly ModelNode[]): string {
  const segments = symbol.name.split(".");
  for (let n = segments.length - 1; n > 0; n--) {
    const scopeId = `${fileId}${SYMBOL_SEP}${segments.slice(0, n).join(".")}`;
    if (bySymbolId.has(scopeId)) return scopeId;
  }
  return innermostEnclosing(symbol, siblings)?.id ?? fileId;
}

function symbolsByFile(model: ReadModel, byId: ReadonlyMap<string, TreeNode>): Map<string, ModelNode[]> {
  const out = new Map<string, ModelNode[]>();
  for (const node of model.nodes) {
    if (node.kind !== "symbol" || node.parentId === null || !byId.has(node.parentId)) continue;
    const list = out.get(node.parentId);
    if (list) list.push(node);
    else out.set(node.parentId, [node]);
  }
  return out;
}

function attachSymbols(model: ReadModel, byId: Map<string, TreeNode>): void {
  for (const [fileId, symbols] of symbolsByFile(model, byId)) {
    const bySymbolId = new Map(symbols.map((s) => [s.id, s]));
    const parentOf = new Map(symbols.map((s) => [s.id, symbolParentId(s, fileId, bySymbolId, symbols)]));
    const pending = [...symbols];
    // Parents attach before children, so repeat passes until every symbol has found its parent in the tree.
    while (pending.length > 0) {
      const ready = pending.filter((s) => byId.has(parentOf.get(s.id)!));
      // Only malformed spans can make a parent cycle; those symbols hang under the file rather than vanish.
      if (ready.length === 0) for (const s of pending) parentOf.set(s.id, fileId);
      for (const s of ready) attach(byId, byId.get(parentOf.get(s.id)!)!, s);
      for (const s of ready) pending.splice(pending.indexOf(s), 1);
    }
  }
}

const KIND_ORDER: Record<string, number> = { directory: 0, file: 1, symbol: 2 };

function compareSiblings(a: TreeNode, b: TreeNode): number {
  const byKind = (KIND_ORDER[a.ref.kind] ?? 3) - (KIND_ORDER[b.ref.kind] ?? 3);
  if (byKind !== 0) return byKind;
  const byLine = (a.ref.span?.startLine ?? Infinity) - (b.ref.span?.startLine ?? Infinity);
  if (byLine !== 0 && !Number.isNaN(byLine)) return byLine;
  return a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0;
}

function finish(node: TreeNode, depth: number): void {
  node.depth = depth;
  node.children.sort(compareSiblings);
  for (const child of node.children) finish(child, depth + 1);
}

function buildTree(model: ReadModel, excludeRoles: ReadonlySet<string>): Tree {
  const root = treeNode({ id: REPO_ID, kind: "repo", name: ".", path: "" }, null);
  const byId = new Map<string, TreeNode>([[REPO_ID, root]]);
  for (const node of model.nodes) {
    if (node.kind !== "file" || (node.role !== undefined && excludeRoles.has(node.role))) continue;
    attach(byId, ensureDirectory(byId, dirPath(node.id)), node);
  }
  attachSymbols(model, byId);
  finish(root, 0);
  return { root, byId };
}

const trees = new WeakMap<ReadModel, Map<string, Tree>>();

/** The hierarchy for a snapshot without files of the given roles; built once per model and role set. */
export function treeFor(model: ReadModel, excludeRoles: readonly string[] = []): Tree {
  const roles = [...new Set(excludeRoles)].sort();
  const key = roles.join("\n");
  let byKey = trees.get(model);
  if (!byKey) trees.set(model, (byKey = new Map()));
  let tree = byKey.get(key);
  if (!tree) byKey.set(key, (tree = buildTree(model, new Set(roles))));
  return tree;
}
