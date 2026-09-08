import {
  Node,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

/**
 * Persisted qualitative facts about a declaration (C-79): the one-line type
 * `signature` and the leading docstring `purpose`, so `graph context` can answer
 * "what is this and how is it called" without the reader opening the file — the
 * G1/G2 gap the C-74 spike found vs brain's codebase module.
 *
 * Both are pure syntactic projections of the declaration (params + explicit
 * return annotation + JSDoc), so an unchanged file's symbol nodes stay
 * byte-identical and the incremental indexer carries them forward. Inferred
 * types are only used when they carry no `import("…")` module path — those embed
 * absolute paths that are non-deterministic and reuse-breaking.
 */
export interface SymbolText {
  signature?: string;
  purpose?: string;
}

const MAX_SIGNATURE = 200;
const MAX_PURPOSE = 240;

type Callable =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;

/** Signature + docstring for a ts-morph declaration node, best-effort. */
export function declarationText(decl: Node): SymbolText {
  const out: SymbolText = {};
  const signature = signatureOf(decl);
  if (signature) out.signature = signature;
  const purpose = purposeOf(decl);
  if (purpose) out.purpose = purpose;
  return out;
}

/**
 * The file-level declaration named `name`, for the non-exported symbol surface
 * (model B, C-64) where only the name + tree-sitter span is known. Class methods
 * are not addressable by file-level name, so they resolve to undefined (no
 * signature) — acceptable, the exported API is the primary target.
 */
export function lookupDeclaration(
  sf: SourceFile,
  name: string,
): Node | undefined {
  return (
    sf.getFunction(name) ??
    sf.getClass(name) ??
    sf.getInterface(name) ??
    sf.getTypeAlias(name) ??
    sf.getEnum(name) ??
    sf.getVariableDeclaration(name)
  );
}

function signatureOf(decl: Node): string | undefined {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    return callableSignature(decl, decl.getName() ?? "");
  }
  if (Node.isVariableDeclaration(decl)) return variableSignature(decl);
  if (Node.isClassDeclaration(decl)) return clamp(`class ${decl.getName() ?? ""}`.trim());
  if (Node.isInterfaceDeclaration(decl)) return clamp(`interface ${decl.getName()}`);
  if (Node.isTypeAliasDeclaration(decl)) {
    return clamp(`type ${decl.getName()} = ${oneLine(decl.getTypeNode()?.getText() ?? "")}`);
  }
  if (Node.isEnumDeclaration(decl)) return clamp(`enum ${decl.getName()}`);
  return undefined;
}

function variableSignature(decl: VariableDeclaration): string | undefined {
  const init = decl.getInitializer();
  if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
    return callableSignature(init, decl.getName());
  }
  const typeNode = decl.getTypeNode();
  const type = typeNode ? oneLine(typeNode.getText()) : cleanType(() => decl.getType().getText());
  return type ? clamp(`${decl.getName()}: ${type}`) : undefined;
}

function callableSignature(decl: Callable, name: string): string {
  const params = decl.getParameters().map((p) => oneLine(p.getText())).join(", ");
  const ret = returnType(decl);
  return clamp(`${name}(${params})${ret ? `: ${ret}` : ""}`);
}

function returnType(decl: Callable): string | undefined {
  const node = decl.getReturnTypeNode();
  if (node) return oneLine(node.getText());
  return cleanType(() => decl.getReturnType().getText());
}

/**
 * Inferred type text, but only when it carries no `import("…")` module path
 * (those embed absolute paths → non-deterministic + reuse-breaking). Returns
 * undefined rather than a dirty type, so the signature simply omits it.
 */
function cleanType(getText: () => string): string | undefined {
  let text: string;
  try {
    text = getText();
  } catch {
    return undefined;
  }
  if (!text || text.includes("import(")) return undefined;
  return oneLine(text);
}

function purposeOf(decl: Node): string | undefined {
  const docs = jsDocsFor(decl);
  if (!docs || docs.length === 0) return undefined;
  const desc = docs[docs.length - 1]!.getDescription().trim();
  return desc ? clamp(oneLine(desc), MAX_PURPOSE) : undefined;
}

function jsDocsFor(decl: Node) {
  if (Node.isJSDocable(decl)) return decl.getJsDocs();
  if (Node.isVariableDeclaration(decl)) return decl.getVariableStatement()?.getJsDocs();
  return undefined;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp(s: string, max = MAX_SIGNATURE): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
