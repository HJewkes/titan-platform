import { describe, expect, it } from "vitest";
import {
  NAMED_FUNCTION_TYPES,
  PY_DECL_TYPES,
  PY_FUNCTION_TYPES,
  TS_BOUND_FUNCTION_TYPES,
  TS_CLASS_TYPES,
  TS_DECL_TYPES,
  TS_FUNCTION_DECLARATION,
  TS_FUNCTION_DECL_TYPES,
  TS_FUNCTION_TYPES,
} from "./node-kinds.js";

const sorted = (set: ReadonlySet<string>) => [...set].sort();

// Each row is the set a caller restated by hand before the table was shared, so a change to
// the table that would move a caller's metrics fails here first.
describe("shared node-kind table keeps each caller's former set", () => {
  it.each([
    ["declared-names TS declarations", TS_DECL_TYPES, [
      "abstract_class_declaration", "class_declaration", "function_declaration",
      "generator_function_declaration", "method_definition",
    ]],
    ["declared-names and scope-path Python declarations", PY_DECL_TYPES, ["class_definition", "function_definition"]],
    ["scope-path and lcom TS classes", TS_CLASS_TYPES, ["abstract_class_declaration", "class", "class_declaration"]],
    ["scope-path and source-metrics named TS functions", TS_FUNCTION_DECL_TYPES, [
      "function_declaration", "generator_function_declaration", "method_definition",
    ]],
    ["scope-path and source-metrics bound TS functions", TS_BOUND_FUNCTION_TYPES, [
      "arrow_function", "function_expression", "generator_function",
    ]],
    ["source-metrics and cognitive-complexity Python functions", PY_FUNCTION_TYPES, ["function_definition"]],
    ["dead-code and cognitive-complexity TS functions", TS_FUNCTION_TYPES, [
      "arrow_function", "function_declaration", "function_expression",
      "generator_function", "generator_function_declaration", "method_definition",
    ]],
    ["growth-risk named functions", NAMED_FUNCTION_TYPES, [
      "function_declaration", "function_definition", "generator_function_declaration", "method_definition",
    ]],
  ])("%s", (_caller, set, expected) => {
    expect(sorted(set)).toEqual(expected);
  });

  it("names the hoisted declaration dead-code exempts after a terminal", () => {
    expect(TS_FUNCTION_DECLARATION).toBe("function_declaration");
  });
});
