import {
  Node,
  SyntaxKind,
  type ObjectBindingPattern,
  type SourceFile,
} from "ts-morph";
import type { GraphEdge } from "../types.js";
import { symbolId } from "./ids.js";
import { addWeightedEdge } from "./reference-weight.js";

/**
 * String-literal specifiers of dynamic `import("…")` expressions in a file
 * (C-65). The static import graph only records `import`/`export` *declarations*,
 * so a module loaded lazily — e.g. `cli/src/index.ts` doing
 * `import("./commands/analyze.js")` to register a command — otherwise has no
 * inbound edge and reads `fan_in` 0, falsely appearing dead. Capturing these
 * closes that blind spot for the common case.
 *
 * Only string-literal specifiers are returned; a computed specifier
 * (`import(variable)`) is genuinely unresolvable statically and is left out (a
 * documented blind spot, same class as DI/registry-string wiring).
 */
export function dynamicImportSpecifiers(sourceFile: SourceFile): string[] {
  const out: string[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (arg && arg.getKind() === SyntaxKind.StringLiteral) {
      out.push(arg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText());
    }
  }
  return out;
}

/** One export pulled out of a destructured dynamic import. */
interface DynamicImportBinding {
  specifier: string;
  /** The name as exported by the target module (property name, not local alias). */
  importedName: string;
}

/**
 * Destructured bindings of a dynamic import — `const { runX } = await import("…")`
 * — pairing each pulled-out export with its target module (C-68). This is the
 * lazy-command-loading pattern (the CLI registers a subcommand via
 * `const { runX } = await import("./x.js")`); C-65 captured only the module
 * edge, so the target's export still read as unused despite being live. Emitting
 * a per-symbol `references` edge from these clears that dead-code false positive.
 *
 * Only object destructuring binds a specific export. `const ns = await import(…)`
 * (namespace) and `.then(m => m.x)` are excluded — the module `imports` edge
 * already accounts for the whole-module dependency, exactly as a static
 * namespace import is handled (C-53). The property name (not the local alias) is
 * returned, matching how a `symbol` node is keyed.
 */
function dynamicImportBindings(
  sourceFile: SourceFile,
): DynamicImportBinding[] {
  const out: DynamicImportBinding[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (!arg || arg.getKind() !== SyntaxKind.StringLiteral) continue;
    const pattern = destructuredTargetOf(call);
    if (!pattern) continue;
    const specifier = arg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
    for (const importedName of destructuredNames(pattern)) {
      out.push({ specifier, importedName });
    }
  }
  return out;
}

/**
 * The object-binding pattern a dynamic `import()` call feeds, if the call is the
 * initializer of a `const { … } = (await) import(…)` declaration. Returns
 * undefined for a namespace binding, a `.then()` chain, or any non-initializer
 * position — those don't destructure a specific export.
 */
function destructuredTargetOf(call: Node): ObjectBindingPattern | undefined {
  const parent = call.getParent();
  if (!parent) return undefined;
  const init = Node.isAwaitExpression(parent) ? parent : call;
  const decl = init.getParent();
  if (!decl || !Node.isVariableDeclaration(decl)) return undefined;
  if (decl.getInitializer() !== init) return undefined;
  const nameNode = decl.getNameNode();
  return Node.isObjectBindingPattern(nameNode) ? nameNode : undefined;
}

/**
 * Exported names bound by an object pattern: `{ runX }` → `runX`,
 * `{ runX: local }` → `runX` (the exported name, not the alias). A rest element
 * (`{ ...rest }`) binds no single export and is skipped.
 */
function destructuredNames(pattern: ObjectBindingPattern): string[] {
  const names: string[] = [];
  for (const el of pattern.getElements()) {
    if (el.getDotDotDotToken()) continue;
    const nameNode = el.getPropertyNameNode() ?? el.getNameNode();
    names.push(nameNode.getText());
  }
  return names;
}

/**
 * Add a `references` edge (importer → target symbol) for each destructured
 * dynamic import in a file (C-68). Kept here rather than in the extractor class
 * so the churn-hot, LOC-bound extractor body stays minimal; specifier→file
 * resolution is delegated to the caller (it needs the ts-morph project's
 * filesystem host). A target the module doesn't export dangles and is pruned
 * after assembly (`pruneDanglingReferences`).
 */
export function recordDynamicSymbolRefEdges(
  sourceFile: SourceFile,
  srcFileId: string,
  agg: Map<string, GraphEdge>,
  resolveSpecifier: (specifier: string) => string | null,
): void {
  for (const binding of dynamicImportBindings(sourceFile)) {
    const targetFileId = resolveSpecifier(binding.specifier);
    if (!targetFileId) continue;
    addWeightedEdge(
      agg,
      srcFileId,
      symbolId(targetFileId, binding.importedName),
      "references",
      binding.specifier,
      1,
    );
  }
}
