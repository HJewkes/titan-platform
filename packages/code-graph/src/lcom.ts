import type { ParsedFile } from "./parser/index.js";
import type { Node } from "web-tree-sitter";
import type { GraphMetric } from "./types.js";

/**
 * Lack of Cohesion of Methods, LCOM4 variant: count connected components
 * in the graph where each method is a node and two methods are linked when
 * they share at least one `this.<x>` (or `self.<x>`) reference or one calls
 * the other. LCOM4=1 → cohesive class; LCOM4>1 → the class could be split.
 *
 * Static methods and constructors are excluded (they don't bind to `this`).
 * Files with no classes emit no metrics. Files with classes emit
 * `lcom4_max` (max LCOM4 across classes in the file) and `class_count`.
 */
export function computeLcomMetrics(
  file: ParsedFile,
  fileId: string,
): GraphMetric[] {
  const classes = collectClasses(file);
  if (classes.length === 0) return [];
  const out: GraphMetric[] = [
    {
      nodeId: fileId,
      name: "class_count",
      value: classes.length,
      unit: "count",
    },
  ];
  const scores = classes
    .map((c) => lcom4OfClass(c, file.language))
    .filter((s): s is number => s !== null);
  if (scores.length > 0) {
    out.push({
      nodeId: fileId,
      name: "lcom4_max",
      value: Math.max(...scores),
      unit: "count",
    });
  }
  return out;
}

function collectClasses(file: ParsedFile): Node[] {
  const isClass =
    file.language === "python"
      ? (n: Node) => n.type === "class_definition"
      : (n: Node) =>
          n.type === "class_declaration" || n.type === "class_expression";
  const out: Node[] = [];
  const visit = (node: Node): void => {
    if (isClass(node)) out.push(node);
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(file.tree.rootNode);
  return out;
}

interface MethodInfo {
  name: string;
  usedNames: Set<string>;
}

function lcom4OfClass(classNode: Node, language: string): number | null {
  const methods = collectMethods(classNode, language);
  if (methods.length === 0) return null;
  if (methods.length === 1) return 1;
  return countComponents(methods);
}

function collectMethods(classNode: Node, language: string): MethodInfo[] {
  return language === "python"
    ? collectPythonMethods(classNode)
    : collectTsMethods(classNode);
}

function collectTsMethods(classNode: Node): MethodInfo[] {
  const body = classNode.childForFieldName("body");
  if (!body) return [];
  const out: MethodInfo[] = [];
  for (const child of body.namedChildren) {
    if (!child || child.type !== "method_definition") continue;
    if (hasStaticModifier(child)) continue;
    const name = methodName(child);
    if (!name || name === "constructor") continue;
    out.push({ name, usedNames: thisRefs(child, "this") });
  }
  return out;
}

function collectPythonMethods(classNode: Node): MethodInfo[] {
  const body = classNode.childForFieldName("body");
  if (!body) return [];
  const out: MethodInfo[] = [];
  for (const child of body.namedChildren) {
    if (!child || child.type !== "function_definition") continue;
    const name = child.childForFieldName("name")?.text;
    if (!name || name === "__init__") continue;
    if (isPythonStaticOrClassMethod(child)) continue;
    out.push({ name, usedNames: thisRefs(child, "self") });
  }
  return out;
}

function methodName(methodNode: Node): string | null {
  const nameNode = methodNode.childForFieldName("name");
  return nameNode?.text ?? null;
}

function hasStaticModifier(methodNode: Node): boolean {
  for (const child of methodNode.children) {
    if (child?.type === "static") return true;
  }
  return false;
}

function isPythonStaticOrClassMethod(funcNode: Node): boolean {
  let prev = funcNode.previousNamedSibling;
  while (prev && prev.type === "decorator") {
    const text = prev.text;
    if (text.includes("@staticmethod") || text.includes("@classmethod")) {
      return true;
    }
    prev = prev.previousNamedSibling;
  }
  return false;
}

function thisRefs(methodNode: Node, selfKeyword: string): Set<string> {
  const out = new Set<string>();
  const visit = (n: Node): void => {
    collectThisRef(n, selfKeyword, out);
    for (const child of n.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(methodNode);
  return out;
}

function collectThisRef(
  n: Node,
  selfKeyword: string,
  out: Set<string>,
): void {
  if (n.type === "member_expression" || n.type === "attribute") {
    const obj = n.childForFieldName("object");
    if (!obj) return;
    if (matchesSelf(obj, selfKeyword)) {
      const prop =
        n.childForFieldName("property") ?? n.childForFieldName("attribute");
      if (prop) out.add(prop.text);
    }
  }
}

function matchesSelf(node: Node, selfKeyword: string): boolean {
  if (selfKeyword === "this") return node.type === "this";
  return node.type === "identifier" && node.text === selfKeyword;
}

function countComponents(methods: readonly MethodInfo[]): number {
  const n = methods.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i]! !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (areLinked(methods[i]!, methods[j]!)) union(i, j);
    }
  }
  const roots = new Set<number>();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

function areLinked(a: MethodInfo, b: MethodInfo): boolean {
  if (a.usedNames.has(b.name)) return true;
  if (b.usedNames.has(a.name)) return true;
  for (const name of a.usedNames) {
    if (b.usedNames.has(name)) return true;
  }
  return false;
}
