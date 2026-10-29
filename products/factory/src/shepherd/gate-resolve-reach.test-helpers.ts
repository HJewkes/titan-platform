import { dirname, resolve } from "node:path";
import ts from "typescript";

/** The module specifier a node names: an import, re-export, `import()` type or call, `require`, or module augmentation. */
function specifierOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  const isLoad = ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"));
  return isLoad ? node.arguments[0] : undefined;
}

/** The program's files one file loads, by module specifier or `/// <reference path>`, as the checker resolved them. */
function importsOf(program: ts.Program, file: ts.SourceFile): ts.SourceFile[] {
  const checker = program.getTypeChecker();
  const found = file.referencedFiles.map((ref) => program.getSourceFile(resolve(dirname(file.fileName), ref.fileName)));
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    const declaration = specifier && ts.isStringLiteralLike(specifier) ? checker.getSymbolAtLocation(specifier)?.valueDeclaration : undefined;
    if (declaration && ts.isSourceFile(declaration)) found.push(declaration);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.filter((imported): imported is ts.SourceFile => imported !== undefined);
}

/** A script or a `declare global` block puts names in every file's scope without an import edge to follow. */
const declaresGlobals = (file: ts.SourceFile): boolean =>
  !ts.isExternalModule(file) || file.statements.some((statement) => ts.isModuleDeclaration(statement) && (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0);

/**
 * The scanned files that load a seed file, directly or through other files (TP-4452). A file that reaches no seed can
 * name no seed declaration, so the checker would find nothing in it. A global declaration that reaches a seed is in
 * every file's scope, so then every scanned file counts.
 */
export function filesReaching(program: ts.Program, inRepo: (file: ts.SourceFile) => boolean, isSeed: (file: ts.SourceFile) => boolean, scanned: readonly ts.SourceFile[]): ts.SourceFile[] {
  const repoFiles = program.getSourceFiles().filter(inRepo);
  const importers = new Map<ts.SourceFile, ts.SourceFile[]>();
  for (const file of repoFiles) {
    for (const imported of importsOf(program, file)) importers.set(imported, [...(importers.get(imported) ?? []), file]);
  }
  const reached = new Set(repoFiles.filter(isSeed));
  for (const file of reached) {
    for (const importer of importers.get(file) ?? []) reached.add(importer);
  }
  return repoFiles.some((file) => reached.has(file) && declaresGlobals(file)) ? [...scanned] : scanned.filter((file) => reached.has(file));
}
