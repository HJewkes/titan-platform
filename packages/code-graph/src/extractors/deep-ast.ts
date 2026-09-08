import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  Node,
  Project,
  ScriptTarget,
  type ArrowFunction,
  type ClassDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type SourceFile,
} from "ts-morph";
import { declarationText, lookupDeclaration } from "./symbol-signature.js";

/**
 * C-81 — **deep AST on-pull**. Structural facts too heavy to persist at index
 * time (class members, per-parameter types, return type) are recomputed lazily
 * here from the working-tree source when a consumer actually pulls a target.
 * Persisting them would bloat every symbol node and break the incremental reuse
 * basis (inferred types embed absolute `import("…")` paths); computing on demand
 * keeps the index lean while still answering "what are the members / params of
 * this" for the one target being read.
 *
 * A single-file in-memory ts-morph project (no tsconfig, no dependency walk) —
 * so the extraction is cheap and reads only explicit syntactic annotations.
 */
export interface ParamInfo {
  name: string;
  type: string | null;
}

export interface MemberInfo {
  name: string;
  memberKind: string;
  signature: string | null;
  isStatic: boolean;
}

export interface DeepAst {
  target: string;
  kind: "file" | "symbol";
  declarationKind: string | null;
  signature: string | null;
  purpose: string | null;
  params: ParamInfo[];
  returnType: string | null;
  /** Class/interface members for a symbol; exported declarations for a file. */
  members: MemberInfo[];
  note?: string;
}

export interface DeepAstInput {
  /** Repo-relative file id, e.g. `src/a.ts`. */
  filePath: string;
  /** Absolute path to the file on disk. */
  absPath: string;
  /** Symbol name for a symbol target; omit for a file target. */
  symbolName?: string;
}

type Callable =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;

/** Deep structural facts for one target, or null when the source is unreadable. */
export function computeDeepAst(input: DeepAstInput): DeepAst | null {
  const sf = loadSourceFile(input.absPath);
  if (!sf) return null;
  const target = input.symbolName
    ? `${input.filePath}#${input.symbolName}`
    : input.filePath;
  return input.symbolName
    ? symbolDeepAst(sf, input.symbolName, target)
    : fileDeepAst(sf, target);
}

function loadSourceFile(absPath: string): SourceFile | null {
  try {
    const text = readFileSync(absPath, "utf8");
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { target: ScriptTarget.Latest, allowJs: true },
    });
    return project.createSourceFile(`f${path.extname(absPath) || ".ts"}`, text);
  } catch {
    return null;
  }
}

function symbolDeepAst(sf: SourceFile, name: string, target: string): DeepAst {
  const decl = lookupDeclaration(sf, name);
  if (!decl) {
    return { ...empty(target, "symbol"), note: "declaration not found in source" };
  }
  const text = declarationText(decl);
  return {
    target,
    kind: "symbol",
    declarationKind: decl.getKindName(),
    signature: text.signature ?? null,
    purpose: text.purpose ?? null,
    params: paramsOf(decl),
    returnType: returnTypeOf(decl),
    members: membersOf(decl),
  };
}

function fileDeepAst(sf: SourceFile, target: string): DeepAst {
  return {
    ...empty(target, "file"),
    declarationKind: "SourceFile",
    members: exportedDeclarations(sf),
  };
}

function empty(target: string, kind: "file" | "symbol"): DeepAst {
  return {
    target,
    kind,
    declarationKind: null,
    signature: null,
    purpose: null,
    params: [],
    returnType: null,
    members: [],
  };
}

/** Unwrap a declaration to the callable it defines, or null for non-callables. */
function callableOf(decl: Node): Callable | null {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  return null;
}

function paramsOf(decl: Node): ParamInfo[] {
  const callable = callableOf(decl);
  if (!callable) return [];
  return callable.getParameters().map((p) => ({
    name: p.getName(),
    type: p.getTypeNode()?.getText() ?? null,
  }));
}

function returnTypeOf(decl: Node): string | null {
  return callableOf(decl)?.getReturnTypeNode()?.getText() ?? null;
}

function membersOf(decl: Node): MemberInfo[] {
  if (Node.isClassDeclaration(decl)) return classMembers(decl);
  if (Node.isInterfaceDeclaration(decl)) return interfaceMembers(decl);
  return [];
}

function classMembers(cls: ClassDeclaration): MemberInfo[] {
  return cls.getMembers().map((m) => ({
    name: memberName(m),
    memberKind: m.getKindName(),
    signature: memberSignature(m),
    isStatic: Node.isStaticable(m) ? m.isStatic() : false,
  }));
}

function interfaceMembers(iface: InterfaceDeclaration): MemberInfo[] {
  return iface.getMembers().map((m) => ({
    name: memberName(m),
    memberKind: m.getKindName(),
    signature: memberSignature(m),
    isStatic: false,
  }));
}

function exportedDeclarations(sf: SourceFile): MemberInfo[] {
  const out: MemberInfo[] = [];
  for (const [name, decls] of sf.getExportedDeclarations()) {
    const decl = decls[0];
    if (!decl) continue;
    out.push({
      name,
      memberKind: decl.getKindName(),
      signature: declarationText(decl).signature ?? memberSignature(decl),
      isStatic: false,
    });
  }
  return out;
}

function memberName(m: Node): string {
  if (Node.isConstructorDeclaration(m)) return "constructor";
  return Node.hasName(m) ? m.getName() : "";
}

function memberSignature(m: Node): string | null {
  if (
    Node.isMethodDeclaration(m) ||
    Node.isMethodSignature(m) ||
    Node.isConstructorDeclaration(m)
  ) {
    const params = m.getParameters().map((p) => oneLine(p.getText())).join(", ");
    const ret = m.getReturnTypeNode()?.getText();
    const name = Node.isConstructorDeclaration(m) ? "constructor" : memberName(m);
    return oneLine(`${name}(${params})${ret ? `: ${ret}` : ""}`);
  }
  if (Node.isPropertyDeclaration(m) || Node.isPropertySignature(m)) {
    const type = m.getTypeNode()?.getText();
    return oneLine(`${memberName(m)}${type ? `: ${type}` : ""}`);
  }
  return null;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
