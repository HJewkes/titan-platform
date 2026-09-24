import { Node } from "ts-morph";
import { ANONYMOUS_SCOPE, qualify } from "../scope-path.js";

/**
 * The ts-morph mirror of `scope-path.ts`: the scope-qualified name tree-sitter
 * gives a declaration, computed from a ts-morph node so a declaration the type
 * checker resolves in any file maps onto that file's symbol id (TP-323). A name
 * the two walks disagree on yields an id with no symbol node, and the edge is
 * pruned, never misattributed.
 */

/** The name a value takes from what it is bound to, as `bindingName` in scope-path.ts; null when unbound. */
function bindingName(node: Node): string | null {
  const parent = node.getParent();
  if (Node.isVariableDeclaration(parent) || Node.isPropertyDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) return parent.getNameNode().getText();
  if (Node.isExportAssignment(parent)) return "default";
  return null;
}

/** A class or function declaration's own name, or `default` for an unnamed default export. */
function declaredName(node: Node & { getName(): string | undefined }): string | null {
  const name = node.getName();
  if (name) return name;
  return Node.isExportable(node) && node.isDefaultExport() ? "default" : null;
}

/** The segment a node adds to the scope of its descendants, or null when it opens no named scope. */
function scopeSegment(node: Node): string | null {
  if (Node.isClassDeclaration(node) || Node.isFunctionDeclaration(node)) return declaredName(node);
  if (Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    return node.getName();
  }
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isModuleDeclaration(node)) return node.hasNamespaceKeyword() ? node.getName() : null;
  if (Node.isClassExpression(node) && node.getName()) return node.getName() ?? null;
  const bound =
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isClassExpression(node) ||
    Node.isObjectLiteralExpression(node);
  return bound ? (bindingName(node) ?? ANONYMOUS_SCOPE) : null;
}

/** The dotted scope path enclosing `node`, collapsing consecutive anonymous segments. */
export function scopeOf(node: Node): string {
  const segments = node
    .getAncestors()
    .map(scopeSegment)
    .filter((s): s is string => s !== null)
    .reverse();
  let scope = "";
  for (const segment of segments) {
    const repeatsAnonymous =
      segment === ANONYMOUS_SCOPE && (scope === ANONYMOUS_SCOPE || scope.endsWith(`.${ANONYMOUS_SCOPE}`));
    if (!repeatsAnonymous) scope = qualify(scope, segment);
  }
  return scope;
}

/**
 * The qualified name of a declaration that has a symbol node: a function,
 * method, accessor, constructor or class, or a variable bound to an arrow or
 * function expression. Null for anything else (a parameter, an interface member).
 */
export function declarationQualifiedName(decl: Node): string | null {
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    const callable = Node.isArrowFunction(init) || Node.isFunctionExpression(init);
    return callable ? qualify(scopeOf(decl), decl.getName()) : null;
  }
  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    const parent = decl.getParent();
    return Node.isVariableDeclaration(parent) ? qualify(scopeOf(parent), parent.getName()) : null;
  }
  const isDeclaration =
    Node.isFunctionDeclaration(decl) ||
    Node.isClassDeclaration(decl) ||
    Node.isMethodDeclaration(decl) ||
    Node.isGetAccessorDeclaration(decl) ||
    Node.isSetAccessorDeclaration(decl) ||
    Node.isConstructorDeclaration(decl);
  const own = isDeclaration ? scopeSegment(decl) : null;
  return own ? qualify(scopeOf(decl), own) : null;
}
