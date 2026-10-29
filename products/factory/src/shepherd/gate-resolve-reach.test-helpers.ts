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

/** The program's files a file's `declare module "<x>"` blocks add names to, so an importer of `<x>` sees them too. */
function augmentedBy(program: ts.Program, file: ts.SourceFile): ts.SourceFile[] {
  const checker = program.getTypeChecker();
  return file.statements.flatMap((statement) => {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) return [];
    const target = checker.getSymbolAtLocation(statement.name)?.declarations?.find(ts.isSourceFile);
    return target && target !== file ? [target] : [];
  });
}

/** A script or a `declare global` block puts names in every file's scope without an import edge to follow. */
const declaresGlobals = (file: ts.SourceFile): boolean =>
  !ts.isExternalModule(file) || file.statements.some((statement) => ts.isModuleDeclaration(statement) && (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0);

/**
 * Library code (`node_modules`, TypeScript's own lib files) never imports repo code, so it cannot carry a sink's names.
 * Not `isSourceFileFromExternalLibrary`: a workspace package's `.d.ts`, reached through its `node_modules` link, counts
 * as external there though its real path is in the repo, and the seeds live in those files.
 */
const isLibrary = (program: ts.Program, file: ts.SourceFile): boolean =>
  program.isSourceFileDefaultLibrary(file) || file.fileName.split(/[\\/]/).includes("node_modules");

/** Maps each file to the files that see its names: its importers, and the files whose module it augments. */
function importersOf(program: ts.Program, files: readonly ts.SourceFile[]): Map<ts.SourceFile, ts.SourceFile[]> {
  const importers = new Map<ts.SourceFile, ts.SourceFile[]>();
  const add = (seen: ts.SourceFile, by: ts.SourceFile): void => void importers.set(seen, [...(importers.get(seen) ?? []), by]);
  for (const file of files) {
    for (const imported of importsOf(program, file)) add(imported, file);
    for (const augmented of augmentedBy(program, file)) add(file, augmented);
  }
  return importers;
}

/**
 * The scanned files that load a seed file, directly or through other files (TP-4452). A file that reaches no seed can
 * name no seed declaration, so the checker would find nothing in it. Edges run through every non-library file, inside a
 * unit or not, and a module augmentation counts as loaded by the module it augments. A global declaration that reaches
 * a seed is in every file's scope, so then every scanned file counts.
 */
export function filesReaching(program: ts.Program, isSeed: (file: ts.SourceFile) => boolean, scanned: readonly ts.SourceFile[]): ts.SourceFile[] {
  const sourceFiles = program.getSourceFiles().filter((file) => !isLibrary(program, file));
  const importers = importersOf(program, sourceFiles);
  const reached = new Set(sourceFiles.filter(isSeed));
  for (const file of reached) {
    for (const importer of importers.get(file) ?? []) reached.add(importer);
  }
  return sourceFiles.some((file) => reached.has(file) && declaresGlobals(file)) ? [...scanned] : scanned.filter((file) => reached.has(file));
}
