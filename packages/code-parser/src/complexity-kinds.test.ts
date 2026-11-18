import { describe, expect, it } from "vitest";
import {
  cyclomaticOf,
  nestingDepthOf,
  PY_BRANCH_TYPES,
  PY_NESTING_TYPES,
  TS_BRANCH_TYPES,
  TS_NESTING_TYPES,
} from "./complexity-kinds.js";
import { parseFile, type GrammarLanguage } from "./parser.js";

const sorted = (set: ReadonlySet<string>) => [...set].sort();

async function firstFunctionBody(source: string, language: GrammarLanguage) {
  const file = await parseFile(source, language === "python" ? "a.py" : "a.ts", language);
  const fnType = language === "python" ? "function_definition" : "function_declaration";
  const fn = file.tree.rootNode.descendantsOfType(fnType)[0];
  const body = fn?.childForFieldName("body");
  if (!body) throw new Error("fixture has no function body");
  return body;
}

describe("complexity node-type tables", () => {
  it("keep the sets code-graph and style-analyzer each restated before sharing", () => {
    expect(sorted(TS_NESTING_TYPES)).toEqual([
      "do_statement", "for_in_statement", "for_statement", "if_statement",
      "switch_statement", "try_statement", "while_statement",
    ]);
    expect(sorted(PY_NESTING_TYPES)).toEqual(["for_statement", "if_statement", "try_statement", "while_statement"]);
    expect(sorted(TS_BRANCH_TYPES)).toEqual([
      "catch_clause", "do_statement", "for_in_statement", "for_statement", "if_statement",
      "switch_case", "ternary_expression", "while_statement",
    ]);
    expect(sorted(PY_BRANCH_TYPES)).toEqual([
      "conditional_expression", "elif_clause", "except_clause", "for_statement", "if_statement", "while_statement",
    ]);
  });
});

describe("cyclomaticOf", () => {
  it("counts one for straight-line code", async () => {
    const body = await firstFunctionBody("function f() { return 1; }", "typescript");
    expect(cyclomaticOf(body, "typescript")).toBe(1);
  });

  it("adds each branch and short-circuit operator but not other binary operators", async () => {
    const source = "function f(a, b) { if (a && b) { return a + b; } return a || b ? 1 : 2; }";
    const body = await firstFunctionBody(source, "typescript");
    expect(cyclomaticOf(body, "typescript")).toBe(5);
  });

  it("adds Python elif, except and boolean operators", async () => {
    const source = [
      "def f(a, b):",
      "    if a and b:",
      "        return 1",
      "    elif a:",
      "        return 2",
      "    try:",
      "        pass",
      "    except ValueError:",
      "        pass",
    ].join("\n");
    const body = await firstFunctionBody(source, "python");
    expect(cyclomaticOf(body, "python")).toBe(5);
  });
});

describe("nestingDepthOf", () => {
  const elseIfChain = "function f(a) { if (a) { } else if (a) { } else if (a) { if (a) { } } }";

  it("deepens at each nested control statement", async () => {
    const body = await firstFunctionBody("function f(a) { for (;;) { while (a) { if (a) { } } } }", "typescript");
    expect(nestingDepthOf(body, "typescript")).toBe(3);
  });

  it("counts an else-if chain as nesting by default", async () => {
    const body = await firstFunctionBody(elseIfChain, "typescript");
    expect(nestingDepthOf(body, "typescript")).toBe(4);
  });

  it("keeps an else-if chain flat when asked", async () => {
    const body = await firstFunctionBody(elseIfChain, "typescript");
    expect(nestingDepthOf(body, "typescript", 0, { flattenElseIf: true })).toBe(2);
  });
});
