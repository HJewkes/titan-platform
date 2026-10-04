import {
  Node,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  type MethodDeclaration,
  type SetAccessorDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";
import { declarationQualifiedName } from "./ts-scope.js";

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
 * The declaration a symbol name addresses. Symbol names are scope-qualified
 * (`Box.add`, `outer.helper`), which no file-level lookup can reach, so a miss
 * falls through to a qualified-name map of the whole file, built on the first
 * miss and shared by every later lookup through the same resolver. Index-time
 * signatures (model B, C-64) and on-pull deep AST both resolve through here, so
 * the two never disagree about which node a name means.
 */
export function createDeclarationLookup(sf: SourceFile): (name: string) => Node | undefined {
  let qualified: ReadonlyMap<string, Node> | undefined;
  return (name) => {
    const fileLevel = fileLevelDeclaration(sf, name);
    if (fileLevel) return fileLevel;
    qualified ??= qualifiedDeclarations(sf);
    return qualified.get(name);
  };
}

/** One-shot `createDeclarationLookup`, for a caller resolving a single name. */
export function lookupDeclaration(sf: SourceFile, name: string): Node | undefined {
  return createDeclarationLookup(sf)(name);
}

function fileLevelDeclaration(sf: SourceFile, name: string): Node | undefined {
  return (
    sf.getFunction(name) ??
    sf.getClass(name) ??
    sf.getInterface(name) ??
    sf.getTypeAlias(name) ??
    sf.getEnum(name) ??
    sf.getVariableDeclaration(name)
  );
}

function qualifiedDeclarations(sf: SourceFile): ReadonlyMap<string, Node> {
  const byName = new Map<string, Node>();
  sf.forEachDescendant((node) => {
    const name = declarationQualifiedName(node);
    if (name === null) return;
    const held = byName.get(name);
    if (!held || outranks(node, held)) byName.set(name, node);
  });
  return byName;
}

/**
 * Which of two declarations sharing a qualified name speaks for it: an
 * overload's implementation over its signatures (a declaration file has none,
 * so the first overload stands), and a getter over its setter, since the getter
 * carries the property's type. Otherwise the first in source order stays.
 */
function outranks(candidate: Node, held: Node): boolean {
  if (Node.isOverloadable(held) && held.isOverload()) {
    return !(Node.isOverloadable(candidate) && candidate.isOverload());
  }
  return Node.isGetAccessorDeclaration(candidate) && Node.isSetAccessorDeclaration(held);
}

function signatureOf(decl: Node): string | undefined {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    return callableSignature(decl, decl.getName() ?? "");
  }
  if (Node.isGetAccessorDeclaration(decl) || Node.isSetAccessorDeclaration(decl)) {
    return accessorSignature(decl);
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

/**
 * An accessor is signed as the property it exposes, `name: type`: the getter's
 * declared or clean inferred return type, or for a lone setter its parameter's.
 */
function accessorSignature(decl: GetAccessorDeclaration | SetAccessorDeclaration): string {
  const type = Node.isGetAccessorDeclaration(decl) ? returnType(decl) : setterType(decl);
  return clamp(type ? `${decl.getName()}: ${type}` : decl.getName());
}

function setterType(decl: SetAccessorDeclaration): string | undefined {
  const param = decl.getParameters()[0];
  if (!param) return undefined;
  const node = param.getTypeNode();
  return node ? oneLine(node.getText()) : cleanType(() => param.getType().getText());
}

function callableSignature(decl: Callable, name: string): string {
  const params = decl.getParameters().map((p) => oneLine(p.getText())).join(", ");
  const ret = returnType(decl);
  return clamp(`${name}(${params})${ret ? `: ${ret}` : ""}`);
}

function returnType(decl: Callable | GetAccessorDeclaration): string | undefined {
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
