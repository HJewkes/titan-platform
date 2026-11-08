import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { GraphEdge } from "../types.js";
import { addWeightedEdge } from "./reference-weight.js";

/**
 * Specifiers a file hands to a bare `require()` as a static string, in source order (TP-4950). A computed
 * specifier names no module statically and is left out, as a computed `import()` is.
 */
function requiredSpecifiers(sourceFile: SourceFile): string[] {
  if (!sourceFile.getFullText().includes("require(")) return [];
  const out: string[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== "require") continue;
    const [arg, ...rest] = call.getArguments();
    if (rest.length > 0) continue;
    if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) out.push(arg.getLiteralText());
  }
  return out;
}

/**
 * An `imports` edge from the file to each module it loads through `require()`, marked `require: true`.
 * The mark tells a mock-aware reach walk that the hop stays live: `vi.mock` replaces only what `import`
 * loads, so a test that mocks a module it also requires still runs the real one.
 */
export function recordRequireEdges(
  sourceFile: SourceFile,
  srcFileId: string,
  agg: Map<string, GraphEdge>,
  resolve: (specifier: string) => string | null,
): void {
  for (const specifier of requiredSpecifiers(sourceFile)) {
    const dstId = resolve(specifier);
    if (!dstId || dstId === srcFileId) continue;
    addWeightedEdge(agg, srcFileId, dstId, "imports", specifier, 1).require = true;
  }
}
