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

/** Only `import(...)` and `require(...)` sit below statement level; walking every node of every library file costs seconds. */
const loadsInExpressions = (file: ts.SourceFile): boolean => /\b(?:import|require)\s*\(/.test(file.text);

/** The program's files one file loads, by module specifier or `/// <reference path>`, as the checker resolved them. */
function importsOf(program: ts.Program, file: ts.SourceFile): ts.SourceFile[] {
  const checker = program.getTypeChecker();
  const found = file.referencedFiles.map((ref) => program.getSourceFile(resolve(dirname(file.fileName), ref.fileName)));
  const deep = loadsInExpressions(file);
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    const declaration = specifier && ts.isStringLiteralLike(specifier) ? checker.getSymbolAtLocation(specifier)?.valueDeclaration : undefined;
    if (declaration && ts.isSourceFile(declaration)) found.push(declaration);
    if (deep || ts.isSourceFile(node) || ts.isModuleDeclaration(node) || ts.isModuleBlock(node)) ts.forEachChild(node, visit);
  };
  visit(file);
  return found.filter((imported): imported is ts.SourceFile => imported !== undefined);
}

const isAugmentation = (statement: ts.Statement): boolean =>
  ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0);

/**
 * A script or a `declare global` block puts names in every file's scope. A `declare module "<x>"` block merges names
 * into declarations `<x>` may only re-export, so the files that see them need not import `<x>` or this file.
 */
const addsNamesElsewhere = (file: ts.SourceFile): boolean => !ts.isExternalModule(file) || file.statements.some(isAugmentation);

/** Maps each file to the files that import it. */
function importersOf(program: ts.Program, files: readonly ts.SourceFile[]): Map<ts.SourceFile, ts.SourceFile[]> {
  const importers = new Map<ts.SourceFile, ts.SourceFile[]>();
  for (const file of files) {
    for (const imported of importsOf(program, file)) importers.set(imported, [...(importers.get(imported) ?? []), file]);
  }
  return importers;
}

/**
 * The scanned files that load a seed file, directly or through other files (TP-4452). A file that reaches no seed can
 * name no seed declaration, so the checker would find nothing in it. Edges run through every program file, library
 * files included, so a chain through `node_modules` re-exports is followed. A reached file that adds names elsewhere
 * (a global or a module augmentation) can put a seed's names where no edge leads, so then every scanned file counts.
 */
export function filesReaching(program: ts.Program, isSeed: (file: ts.SourceFile) => boolean, scanned: readonly ts.SourceFile[]): ts.SourceFile[] {
  const sourceFiles = program.getSourceFiles();
  const importers = importersOf(program, sourceFiles);
  const reached = new Set(sourceFiles.filter(isSeed));
  for (const file of reached) {
    for (const importer of importers.get(file) ?? []) reached.add(importer);
  }
  return sourceFiles.some((file) => reached.has(file) && addsNamesElsewhere(file)) ? [...scanned] : scanned.filter((file) => reached.has(file));
}
