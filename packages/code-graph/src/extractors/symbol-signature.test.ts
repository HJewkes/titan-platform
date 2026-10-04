import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { declarationText, lookupDeclaration } from "./symbol-signature.js";

const SRC = [
  "class Job {",
  "  run(retries: number): void {}",
  "}",
  "function outer() {",
  "  const helper = (s: string): boolean => s.length > 0;",
  "  return helper;",
  "}",
].join("\n");

function sourceFile() {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile("f.ts", SRC);
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
});
