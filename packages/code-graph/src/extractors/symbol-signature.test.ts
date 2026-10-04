import { describe, it, expect, vi } from "vitest";
import { Project } from "ts-morph";
import { createDeclarationLookup, declarationText, lookupDeclaration } from "./symbol-signature.js";

const SRC = [
  "class Job {",
  "  run(retries: number): void {}",
  "}",
  "function outer() {",
  "  const helper = (s: string): boolean => s.length > 0;",
  "  return helper;",
  "}",
  "class Box {",
  "  add(n: number): number;",
  "  add(s: string): string;",
  "  add(v: number | string): number | string { return v; }",
  "  set v(next: number) {}",
  "  get v(): number { return 1; }",
  "  get inferred() { return 'x'; }",
  "  set only(flag: boolean) {}",
  "}",
].join("\n");

const DECLARATION_SRC = [
  "declare class Box {",
  "  add(n: number): number;",
  "  add(s: string): string;",
  "}",
].join("\n");

function sourceFile(text = SRC, name = "f.ts") {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(name, text);
}

function signatureOf(name: string, sf = sourceFile()) {
  const decl = lookupDeclaration(sf, name);
  return decl && declarationText(decl).signature;
}

describe("lookupDeclaration", () => {
  it("gives a non-exported method the signature index time stores", () => {
    const decl = lookupDeclaration(sourceFile(), "Job.run");
    expect(decl && declarationText(decl).signature).toBe("run(retries: number): void");
  });

  it("gives a nested arrow the signature index time stores", () => {
    const decl = lookupDeclaration(sourceFile(), "outer.helper");
    expect(decl && declarationText(decl).signature).toBe("helper(s: string): boolean");
  });

  it("still resolves a file-level declaration by its bare name", () => {
    expect(lookupDeclaration(sourceFile(), "Job")?.getKindName()).toBe("ClassDeclaration");
  });

  it("returns undefined for a qualified name with no declaration", () => {
    expect(lookupDeclaration(sourceFile(), "Job.missing")).toBeUndefined();
  });

  it("resolves an overloaded method to its implementation, not the first overload", () => {
    expect(signatureOf("Box.add")).toBe("add(v: number | string): number | string");
  });

  it("pins the first overload when a declaration file has no implementation", () => {
    expect(signatureOf("Box.add", sourceFile(DECLARATION_SRC, "f.d.ts"))).toBe("add(n: number): number");
  });

  it("resolves a getter/setter pair to the getter, signed as a property", () => {
    expect(signatureOf("Box.v")).toBe("v: number");
  });

  it("signs an unannotated getter with its clean inferred type", () => {
    expect(signatureOf("Box.inferred")).toBe("inferred: string");
  });

  it("signs a setter with no getter by its parameter type", () => {
    expect(signatureOf("Box.only")).toBe("only: boolean");
  });
});

describe("createDeclarationLookup", () => {
  it("resolves qualified names without re-walking the file per lookup", () => {
    const sf = sourceFile();
    const lookup = createDeclarationLookup(sf);
    lookup("Job.run");
    const walk = vi.spyOn(sf, "forEachDescendant");
    const resolved = ["outer.helper", "Box.add", "Box.v"].map((n) => lookup(n)?.getKindName());
    expect(resolved).toEqual(["VariableDeclaration", "MethodDeclaration", "GetAccessor"]);
    expect(walk).not.toHaveBeenCalled();
  });
});
