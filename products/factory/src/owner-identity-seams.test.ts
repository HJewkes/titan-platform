import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { CliDeps } from "./cli.js";
import type { FactoryServerOptions } from "./serve.js";
import { sourceProgram } from "./shepherd/gate-resolve-closure.test-helpers.js";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const SEAM_NAMES = new Set(["presence", "ownerKeys"]);
const SEAM_TYPES = /\b(OwnerPresence|OwnerKeys|KeyRing)\b/;
const SETTERS = /\bset(OwnerPresenceEdge|OwnerKeysEdge)\b/;

/** The properties of `name` in `file`, own and inherited, named or typed as a check that decides who the owner is. */
function seamsOf(program: ts.Program, file: string, name: string): string[] {
  const checker = program.getTypeChecker();
  const decl = program.getSourceFile(join(SRC, file))!.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name)!;
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(decl.name))
    .filter((property) => SEAM_NAMES.has(property.name) || SEAM_TYPES.test(checker.typeToString(checker.getTypeOfSymbolAtLocation(property, decl))))
    .map((property) => property.name);
}

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));

describe("owner-identity seams", () => {
  it("no production deps type carries an owner-identity check", () => {
    expectTypeOf<CliDeps>().not.toHaveProperty("presence");
    expectTypeOf<FactoryServerOptions>().not.toHaveProperty("ownerKeys");
    const program = sourceProgram([join(SRC, "cli.ts"), join(SRC, "serve.ts")]);

    const seams = [...seamsOf(program, "cli.ts", "CliDeps"), ...seamsOf(program, "serve.ts", "FactoryServerOptions")];

    expect(seams).toEqual([]);
  });

  it("only test-support swaps the owner-presence helper or the owner key directory", () => {
    const callers = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !path.startsWith("test-support/") && SETTERS.test(readFileSync(join(SRC, path), "utf8")));

    expect(callers.sort()).toEqual(["owner-keys.ts", "owner-presence.ts"]);
  });
});
