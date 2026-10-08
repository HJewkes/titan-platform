import { maxFunctionLines } from "./max-function-lines.js";
import { ruleTester } from "./test-fixtures.js";

function message(name: string, lines: number): string {
  return `\`${name}\` is ${lines} lines; the limit is 30. Extract one step into a named function in this file. Do not add eslint-disable and do not edit the suppressions file.`;
}

function statements(count: number, blankEvery = 0): string[] {
  const body: string[] = [];
  for (let i = 0; i < count; i++) {
    if (blankEvery > 0 && i > 0 && i % blankEvery === 0) body.push("");
    body.push(`  const v${i} = ${i};`);
  }
  return body;
}

// Header and closing brace are two of the counted lines.
function declaration(name: string, totalLines: number, blankEvery = 0): string {
  return [`function ${name}() {`, ...statements(totalLines - 2, blankEvery), "}"].join("\n");
}

ruleTester.run("max-function-lines", maxFunctionLines, {
  valid: [
    { name: "a 30-line function passes", code: declaration("thirty", 30) },
    { name: "a 30-line function with 3 blank lines passes", code: declaration("spaced", 30, 9) },
    {
      name: "a nested function's lines count toward the enclosing function only, as in core max-lines-per-function",
      code: `function outer() {\n  function inner() {\n${statements(26).join("\n")}\n  }\n}`,
    },
    { name: "a larger max option admits a longer function", code: declaration("long", 40), options: [{ max: 40 }] },
  ],
  invalid: [
    {
      name: "an outer function fails only because of its nested function",
      code: `function outer() {\n  function inner() {\n${statements(27).join("\n")}\n  }\n}`,
      errors: [{ message: message("outer", 31) }],
    },
    {
      name: "a 31-line function fails with its name and line count",
      code: declaration("thirtyOne", 31),
      errors: [{ message: message("thirtyOne", 31) }],
    },
    {
      name: "an arrow function takes its variable's name",
      code: `const handler = () => {\n${statements(30).join("\n")}\n};`,
      errors: [{ message: message("handler", 32) }],
    },
    {
      name: "a class method takes its key's name",
      code: `class Box {\n  open() {\n${statements(30).join("\n")}\n  }\n}`,
      errors: [{ message: message("open", 32) }],
    },
    {
      name: "an object method takes its property's name",
      code: `const api = {\n  load: function () {\n${statements(30).join("\n")}\n  },\n};`,
      errors: [{ message: message("load", 32) }],
    },
    {
      name: "an assigned member function reports as anonymous",
      code: `obj.m = function () {\n${statements(30).join("\n")}\n};`,
      errors: [{ message: message("anonymous function", 32) }],
    },
    {
      name: "a default-export function declaration keeps its name",
      code: `export default function main() {\n${statements(30).join("\n")}\n}`,
      errors: [{ message: message("main", 32) }],
    },
    {
      name: "an anonymous default-export function is named anonymous",
      code: `export default function () {\n${statements(30).join("\n")}\n}`,
      errors: [{ message: message("anonymous function", 32) }],
    },
    {
      name: "a callback with no binding is named anonymous",
      code: `run(() => {\n${statements(30).join("\n")}\n});`,
      errors: [{ message: message("anonymous function", 32) }],
    },
  ],
});
