import {
  checkMutation,
  MAX_MUTATION_NAME,
  parseFixProofConfig,
  type FixProofConfig,
  type HeadMutation,
} from "@titan-design/fix-proof";
import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { MAX_BODY_DELETES, planBodyDeletes, type BodyDeletePlan } from "./body-delete.js";

const FILE = "src/lib.ts";
const SEED = "0123456789abcdef0123456789abcdef01234567";

function config(): FixProofConfig {
  const read = parseFixProofConfig(null);
  if (!read.ok) throw new Error(read.error);
  return read.config;
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/** Plans one file whose every line changed, with the given covered function start lines. */
function plan(text: string, covered: number[], extra: { max?: number; changed?: [number, number][] } = {}): BodyDeletePlan {
  return planBodyDeletes({
    files: new Map([[FILE, text]]),
    changed: new Map([[FILE, extra.changed ?? [[1, lineCount(text)]]]]),
    covered: new Map([[FILE, new Set(covered)]]),
    seed: SEED,
    ...(extra.max === undefined ? {} : { max: extra.max }),
  });
}

function reasons(result: BodyDeletePlan): Record<string, string> {
  return Object.fromEntries(result.skipped.map(({ nodeId, reason }) => [nodeId, reason]));
}

function apply(text: string, mutation: HeadMutation): string {
  return text.replace(mutation.find, () => mutation.replace);
}

function checkAtHead(mutation: HeadMutation, text: string) {
  return checkMutation(mutation, text, config(), "head");
}

describe("planBodyDeletes", () => {
  it("emits one early-return mutant for a changed, covered function, and it passes checkMutation at head", () => {
    const text = "export function f(a: number) { return a + 1; }\n";

    const result = plan(text, [1]);

    expect(result.skipped).toEqual([]);
    expect(result.targets).toHaveLength(1);
    const [target] = result.targets;
    expect(target).toMatchObject({ nodeId: `${FILE}#f`, file: FILE, symbol: "f", lineStart: 1, lineEnd: 1 });
    expect(target?.mutation).toEqual({
      name: `body-delete:${FILE}#f`,
      file: FILE,
      find: "export function f(a: number) {",
      replace: "export function f(a: number) { return undefined as never;",
    });
    expect(checkAtHead(target!.mutation, text)).toEqual({ ok: true });
  });

  it("skips a changed function Istanbul did not see run as uncovered", () => {
    const text = "function hit() {\n  return 1;\n}\nfunction miss() {\n  return 2;\n}\n";

    const result = plan(text, [1]);

    expect(result.targets.map((t) => t.symbol)).toEqual(["hit"]);
    expect(reasons(result)).toEqual({ [`${FILE}#miss`]: "uncovered" });
  });

  it("treats a file with no coverage entry as uncovered, never covered", () => {
    const result = planBodyDeletes({
      files: new Map([[FILE, "function f() {\n  return 1;\n}\n"]]),
      changed: new Map([[FILE, [[1, 3]]]]),
      covered: new Map(),
      seed: SEED,
    });

    expect(result.targets).toEqual([]);
    expect(reasons(result)).toEqual({ [`${FILE}#f`]: "uncovered" });
  });

  it("skips a covered function no changed range touches as unchanged", () => {
    const text = "function touched() {\n  return 1;\n}\n\nfunction still() {\n  return 2;\n}\n";

    const result = plan(text, [1, 5], { changed: [[2, 2]] });

    expect(result.targets.map((t) => t.symbol)).toEqual(["touched"]);
    expect(reasons(result)).toEqual({ [`${FILE}#still`]: "unchanged" });
  });

  it("skips expression-bodied arrows, constructors, generators and overloads with their reasons", () => {
    const text = [
      "export const inc = (x: number) => x + 1;",
      "class Box {",
      "  constructor(readonly v: number) {",
      "    this.v = v;",
      "  }",
      "  *items() {",
      "    yield this.v;",
      "  }",
      "}",
      "function over(a: string): string;",
      "function over(a: string) {",
      "  return a;",
      "}",
    ].join("\n");

    const result = plan(text, [1, 3, 6, 10, 11]);

    expect(result.targets.map((t) => t.nodeId)).toEqual([`${FILE}#over@11`]);
    expect(reasons(result)).toEqual({
      [`${FILE}#inc`]: "expression-body",
      [`${FILE}#Box.constructor`]: "constructor",
      [`${FILE}#Box.items`]: "generator",
      [`${FILE}#over`]: "overload-or-abstract",
    });
  });

  it("keeps a nested block-bodied arrow under its own start line and qualified name", () => {
    const text = "function outer() {\n  const inner = () => {\n    return 1;\n  };\n  return inner();\n}\n";

    const result = plan(text, [2]);

    expect(result.targets.map((t) => [t.symbol, t.lineStart])).toEqual([["outer.inner", 2]]);
    expect(result.targets[0]?.mutation.find).toBe("() => {");
    expect(checkAtHead(result.targets[0]!.mutation, text)).toEqual({ ok: true });
  });

  it("widens identical method headers back a line at a time until each find is unique", () => {
    const text = [
      "class A {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "class B {",
      "  run() {",
      "    return 2;",
      "  }",
      "}",
    ].join("\n");

    const result = plan(text, [2, 7]);

    expect(result.targets.map((t) => t.mutation.find)).toEqual(["class A {\n  run() {", "class B {\n  run() {"]);
    for (const target of result.targets) expect(checkAtHead(target.mutation, text)).toEqual({ ok: true });
  });

  it("skips a header that cannot be widened into a unique find as find-not-unique", () => {
    const text = "function f() { return 1; }\nfunction f() { return 1; }\n";

    const result = plan(text, [1, 2]);

    expect(reasons(result)).toEqual({ [`${FILE}#f`]: "find-not-unique" });
    expect(result.targets.map((t) => t.mutation.find)).toEqual(["function f() { return 1; }\nfunction f() {"]);
  });

  it("skips a find that only becomes unique past the edit cap as find-over-cap", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `  // shared line ${i}`).join("\n");
    const text = `class A {\n${filler}\n  run() {\n    return 1;\n  }\n}\nclass B {\n${filler}\n  run() {\n    return 2;\n  }\n}\n`;
    const runLines = text.split("\n").flatMap((line, i) => (line === "  run() {" ? [i + 1] : []));

    const result = plan(text, runLines);

    expect(result.targets).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["find-over-cap", "find-over-cap"]);
  });

  it("keeps a seeded sample of max targets over the cap, the same one on a rerun, and caps the rest", () => {
    const text = Array.from({ length: 30 }, (_, i) => `function f${i}() {\n  return ${i};\n}`).join("\n");
    const starts = Array.from({ length: 30 }, (_, i) => 3 * i + 1);

    const first = plan(text, starts, { max: 10 });
    const again = plan(text, starts, { max: 10 });

    expect(first.targets).toHaveLength(10);
    expect(again.targets.map((t) => t.nodeId)).toEqual(first.targets.map((t) => t.nodeId));
    expect(first.skipped).toHaveLength(20);
    expect(first.skipped.every((s) => s.reason === "capped")).toBe(true);
    const kept = new Set(first.targets.map((t) => t.nodeId));
    expect(first.skipped.some((s) => kept.has(s.nodeId))).toBe(false);
  });

  it("samples a different set under another seed", () => {
    const text = Array.from({ length: 30 }, (_, i) => `function f${i}() {\n  return ${i};\n}`).join("\n");
    const input = {
      files: new Map([[FILE, text]]),
      changed: new Map([[FILE, [[1, 90] as [number, number]]]]),
      covered: new Map([[FILE, new Set(Array.from({ length: 30 }, (_, i) => 3 * i + 1))]]),
    };

    const one = planBodyDeletes({ ...input, seed: "a" }).targets.map((t) => t.nodeId);
    const other = planBodyDeletes({ ...input, seed: "b" }).targets.map((t) => t.nodeId);

    expect(one).toHaveLength(MAX_BODY_DELETES);
    expect(other).not.toEqual(one);
  });

  it("names same-named functions in two files apart, so head mode can key runs by name", () => {
    const text = "export function run() {\n  return 1;\n}\n";
    const files = new Map([["src/a.ts", text], ["src/b.ts", text]]);

    const result = planBodyDeletes({
      files,
      changed: new Map([...files.keys()].map((file) => [file, [[1, 3] as [number, number]]])),
      covered: new Map([...files.keys()].map((file) => [file, new Set([1])])),
      seed: SEED,
    });

    expect(result.targets.map((t) => t.mutation.name)).toEqual(["body-delete:src/a.ts#run", "body-delete:src/b.ts#run"]);
  });

  it("gives three anonymous functions on one line three distinct names", () => {
    const text = "[1].map(function () { return 1; }).map(function () { return 2; }).map(function () { return 3; });\n";

    const result = plan(text, [1]);

    const names = result.targets.map((t) => t.mutation.name);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it("keeps a long qualified name within fix-proof's name cap and apart from a sibling sharing its tail", () => {
    const deep = "VeryLongOuterClassNameForTesting";
    const text = [
      `class ${deep}A { methodWithAnEvenLongerNameThanUsual() {\n    return 1;\n  } }`,
      `class ${deep}B { methodWithAnEvenLongerNameThanUsual() {\n    return 2;\n  } }`,
    ].join("\n");

    const result = plan(text, [1, 4]);

    const names = result.targets.map((t) => t.mutation.name);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(MAX_MUTATION_NAME);
    expect(names[0]).not.toBe(names[1]);
  });

  it("refuses a max that is not a non-negative integer", () => {
    expect(() => plan("function f() {}\n", [1], { max: -1 })).toThrow(RangeError);
  });

  it("gives mutated async, Promise-returning, void and method bodies that still type-check", () => {
    const text = [
      "export async function load(n: number): Promise<number> {",
      "  return n * 2;",
      "}",
      "export function later(n: number): Promise<number> {",
      "  return Promise.resolve(n);",
      "}",
      "export function log(msg: string): void {",
      "  console.log(msg);",
      "}",
      "export class Counter {",
      "  private n = 0;",
      "  next(): number {",
      "    this.n += 1;",
      "    return this.n;",
      "  }",
      "}",
    ].join("\n");

    const result = plan(text, [1, 4, 7, 12]);
    const mutated = result.targets.reduce((acc, target) => apply(acc, target.mutation), text);

    expect(result.targets.map((t) => t.symbol)).toEqual(["load", "later", "log", "Counter.next"]);
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"] },
    });
    project.createSourceFile(`/${FILE}`, mutated);
    const errors = project.getPreEmitDiagnostics().map((d) => d.getMessageText());
    expect(errors).toEqual([]);
    expect(mutated.match(/return undefined as never;/g)).toHaveLength(4);
  });
});
