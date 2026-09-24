import { Node, SyntaxKind, type CallExpression, type NewExpression, type SourceFile } from "ts-morph";
import type { GraphEdge } from "../types.js";
import { addCallSite, type CallSite } from "./call-sites.js";
import { symbolId } from "./ids.js";
import { inRepoFileId, remapDistToSrc } from "./module-resolution.js";
import { declarationQualifiedName } from "./ts-scope.js";

export interface TsCallContext {
  srcFileId: string;
  /** Qualified names this file has symbol nodes for; a caller must be one of them. */
  localSymbols: ReadonlySet<string>;
  repoRoot: string;
}

type Call = CallExpression | NewExpression;

/**
 * `calls` edges from each call or `new` in a file to the in-repo symbol the type
 * checker resolves its callee to (TP-323). The caller is the nearest enclosing
 * declaration with a symbol node, or the file for a top-level call. A callee the
 * checker cannot resolve to exactly one in-repo declaration is dropped.
 */
export function collectTsCallEdges(sourceFile: SourceFile, ctx: TsCallContext): GraphEdge[] {
  const agg = new Map<string, GraphEdge>();
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) return;
    const dstId = resolveCallee(node, ctx);
    if (dstId) addCallSite(agg, callerId(node, ctx), dstId, tsCallSite(node));
  });
  return [...agg.values()];
}

function resolveCallee(call: Call, ctx: TsCallContext): string | null {
  const callee = call.getExpression();
  if (callee.getKind() === SyntaxKind.SuperKeyword) return null;
  const symbol = callee.getSymbol();
  if (!symbol) return null;
  const target = symbol.isAlias() ? symbol.getAliasedSymbol() : symbol;
  const ids = new Set<string>();
  for (const decl of target?.getDeclarations() ?? []) {
    const id = declarationId(decl, ctx);
    if (id === null) return null;
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

function declarationId(decl: Node, ctx: TsCallContext): string | null {
  const sf = decl.getSourceFile();
  const abs = remapDistToSrc(sf.getFilePath());
  if (sf.isDeclarationFile() && abs === sf.getFilePath()) return null;
  const fileId = inRepoFileId(ctx.repoRoot, abs);
  const name = fileId ? declarationQualifiedName(decl) : null;
  return fileId && name ? symbolId(fileId, name) : null;
}

function callerId(call: Call, ctx: TsCallContext): string {
  for (const ancestor of call.getAncestors()) {
    const name = declarationQualifiedName(ancestor);
    if (name && ctx.localSymbols.has(name)) return symbolId(ctx.srcFileId, name);
  }
  return ctx.srcFileId;
}

function tsCallSite(call: Call): CallSite {
  const site: CallSite = { args: [] };
  for (const arg of call.getArguments()) {
    if (Node.isSpreadElement(arg)) {
      site.spreadFrom ??= site.args.length;
      break;
    }
    site.args.push(literalText(arg));
  }
  return site;
}

const LITERAL_KINDS = new Set([
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

/** The source text of a literal argument (a negative number included), else null. */
function literalText(arg: Node): string | null {
  if (LITERAL_KINDS.has(arg.getKind())) return arg.getText();
  if (Node.isIdentifier(arg) && arg.getText() === "undefined") return "undefined";
  if (Node.isPrefixUnaryExpression(arg) && arg.getOperatorToken() === SyntaxKind.MinusToken) {
    return Node.isNumericLiteral(arg.getOperand()) ? arg.getText() : null;
  }
  return null;
}
