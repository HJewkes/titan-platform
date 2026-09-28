import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDeepAst } from "./deep-ast.js";

const SRC = [
  "/** Adds two numbers. */",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export class Box {",
  "  static empty = 0;",
  "  value: string;",
  "  constructor(v: string) {",
  "    this.value = v;",
  "  }",
  "  size(): number {",
  "    return this.value.length;",
  "  }",
  "}",
].join("\n");

describe("computeDeepAst", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "c81-deep-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), SRC);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("extracts param types, return type and docstring for a function symbol", () => {
    const deep = computeDeepAst({
      filePath: "src/a.ts",
      absPath: join(dir, "src", "a.ts"),
      symbolName: "add",
    });
    expect(deep?.kind).toBe("symbol");
    expect(deep?.declarationKind).toBe("FunctionDeclaration");
    expect(deep?.params).toEqual([
      { name: "a", type: "number" },
      { name: "b", type: "number" },
    ]);
    expect(deep?.returnType).toBe("number");
    expect(deep?.purpose).toMatch(/Adds two numbers/);
  });

  it("extracts class members with static flag and member signatures", () => {
    const deep = computeDeepAst({
      filePath: "src/a.ts",
      absPath: join(dir, "src", "a.ts"),
      symbolName: "Box",
    });
    const byName = new Map(deep?.members.map((m) => [m.name, m]));
    expect(byName.get("empty")?.isStatic).toBe(true);
    expect(byName.get("value")?.signature).toBe("value: string");
    expect(byName.get("constructor")?.signature).toBe("constructor(v: string)");
    expect(byName.get("size")?.signature).toBe("size(): number");
  });

  it("lists exported declarations for a file target", () => {
    const deep = computeDeepAst({
      filePath: "src/a.ts",
      absPath: join(dir, "src", "a.ts"),
    });
    expect(deep?.kind).toBe("file");
    expect(deep?.members.map((m) => m.name).sort()).toEqual(["Box", "add"]);
  });

  it("returns null when the source file cannot be read", () => {
    expect(
      computeDeepAst({ filePath: "src/x.ts", absPath: "/no/such/x.ts", symbolName: "add" }),
    ).toBeNull();
  });
});
