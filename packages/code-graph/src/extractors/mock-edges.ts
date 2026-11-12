import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { GraphEdge } from "../types.js";
import { addWeightedEdge } from "./reference-weight.js";

const MOCK_HOSTS = new Set(["vi", "jest"]);

/**
 * Specifiers a file hands to `vi.mock` or `jest.mock` as a static string, in source order (TP-4910).
 * A computed specifier names no module statically and is left out, as a computed `import()` is.
 */
function mockedSpecifiers(sourceFile: SourceFile): string[] {
  if (!sourceFile.getFullText().includes(".mock(")) return [];
  const out: string[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "mock") continue;
    const host = callee.getExpression();
    if (!Node.isIdentifier(host) || !MOCK_HOSTS.has(host.getText())) continue;
    const arg = call.getArguments()[0];
    if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) out.push(arg.getLiteralText());
  }
  return out;
}

/** The node an `imports` or `re-exports` edge already in `agg` resolved `specifier` to. */
function importedTarget(agg: ReadonlyMap<string, GraphEdge>, specifier: string): string | undefined {
  for (const edge of agg.values()) {
    if ((edge.kind === "imports" || edge.kind === "re-exports") && edge.attrs?.specifier === specifier) return edge.dstId;
  }
  return undefined;
}

/**
 * A `mocks` edge from the file to each module it mocks. A specifier the file also imports takes that
 * import's target, so a mock resolves exactly as the import it replaces; any other goes to `resolve`.
 * Call after the file's import edges are in `agg`.
 */
export function recordMockEdges(
  sourceFile: SourceFile,
  srcFileId: string,
  agg: Map<string, GraphEdge>,
  resolve: (specifier: string) => string | null,
): void {
  for (const specifier of mockedSpecifiers(sourceFile)) {
    const dstId = importedTarget(agg, specifier) ?? resolve(specifier);
    if (dstId && dstId !== srcFileId) addWeightedEdge(agg, srcFileId, dstId, "mocks", specifier, 1);
  }
}
