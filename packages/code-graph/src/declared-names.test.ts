import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { collectDeclaredNames, collectDeclaredSpans } from "./declared-names.js";

const TS = `// a comment
export function alpha(): void {}

const beta = (n: number) => n + 1;

class Gamma {
  delta(): void {}
}
`;

const PY = `def alpha():
    return 1


class Gamma:
    def delta(self):
        return 2
`;

describe("declared names", () => {
  it("collects functions, arrow consts, classes and methods from TypeScript", async () => {
    const file = await parseFile(TS, "/repo/src/a.ts", "typescript");
    expect([...collectDeclaredNames(file)].sort()).toEqual(["Gamma", "Gamma.delta", "alpha", "beta"]);
  });

  it("collects Python functions and classes with 1-based line spans", async () => {
    const file = await parseFile(PY, "/repo/src/a.py", "python");
    const spans = collectDeclaredSpans(file);
    expect([...spans.keys()].sort()).toEqual(["Gamma", "Gamma.delta", "alpha"]);
    expect(spans.get("alpha")).toEqual({ startLine: 1, endLine: 2 });
  });

  it("skips anonymous declarations", async () => {
    const file = await parseFile("export default () => 1;\n", "/repo/src/a.ts", "typescript");
    expect(collectDeclaredNames(file).size).toBe(0);
  });
});

const names = async (source: string, filePath = "/repo/src/a.ts", language = "typescript") =>
  [...collectDeclaredNames(await parseFile(source, filePath, language))].sort();

describe("scope-qualified declared names (TP-182)", () => {
  it("keeps same-named methods and constructors of two classes apart", async () => {
    const src = "class A {\n  constructor() {}\n  run() {}\n}\nclass B {\n  constructor() {}\n  run() {}\n}\n";
    expect(await names(src)).toEqual(["A", "A.constructor", "A.run", "B", "B.constructor", "B.run"]);
  });

  it("leaves top-level ids alone beside a same-named method", async () => {
    expect(await names("export function run() {}\nclass A {\n  run() {}\n}\n")).toEqual(["A", "A.run", "run"]);
  });

  it("gives a getter/setter pair, a static twin and overloads one name per class", async () => {
    const src = [
      "class A {",
      "  get size(): number { return 1; }",
      "  set size(v: number) {}",
      "  static make(): A { return new A(); }",
      "  make(): void {}",
      "  handle(x: string): void;",
      "  handle(x: number): void;",
      "  handle(x: unknown): void {}",
      "}",
    ].join("\n");
    expect(await names(src)).toEqual(["A", "A.handle", "A.make", "A.size"]);
  });

  it("qualifies nested functions, local classes and object-literal methods by their scope", async () => {
    const src = [
      "function outer() {",
      "  function helper() {}",
      "  class Local { run() {} }",
      "}",
      "function other() { const helper = () => 1; }",
      "const handlers = { run() {}, nested: { run() {} }, arrow: () => { function inner() {} } };",
    ].join("\n");
    expect(await names(src)).toEqual([
      "handlers.arrow.inner",
      "handlers.nested.run",
      "handlers.run",
      "other",
      "other.helper",
      "outer",
      "outer.Local",
      "outer.Local.run",
      "outer.helper",
    ]);
  });

  it("marks callback and default-export scopes instead of merging them into a top-level name", async () => {
    const src = [
      "export function run() {}",
      'describe("a", () => { function run() {} it("b", () => { const run = () => 1; }); });',
      "register({ run() {} });",
      "export default class { run() {} }",
    ].join("\n");
    expect(await names(src)).toEqual(["<anonymous>.run", "default.run", "run"]);
  });

  it("does not depend on declaration order", async () => {
    const a = "class A { run() {} }\nclass B { run() {} }\nfunction f() { function g() {} }\n";
    const b = "function f() { function g() {} }\nclass B { run() {} }\nclass A { run() {} }\n";
    expect(await names(b)).toEqual(await names(a));
  });

  it("qualifies Python methods, nested defs and nested classes; a property shares one name", async () => {
    const py = [
      "class A:",
      "    def run(self):",
      "        return 1",
      "",
      "    @property",
      "    def size(self):",
      "        return 1",
      "",
      "    @size.setter",
      "    def size(self, v):",
      "        pass",
      "",
      "    class Inner:",
      "        def run(self):",
      "            return 2",
      "",
      "def outer():",
      "    def run():",
      "        return 3",
      "    return run",
      "",
    ].join("\n");
    expect(await names(py, "/repo/src/a.py", "python")).toEqual([
      "A",
      "A.Inner",
      "A.Inner.run",
      "A.run",
      "A.size",
      "outer",
      "outer.run",
    ]);
  });
});
