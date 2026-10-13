import { maxLineLength } from "./max-line-length.js";
import { ruleTester } from "./test-fixtures.js";

function message(length: number, max = 200): string {
  return `This line is ${length} characters; the limit is ${max}. Name an intermediate value with a const, or break the expression across lines. Do not add eslint-disable and do not edit the suppressions file.`;
}

// A packed guard whose last operand is stretched so the line is exactly `length` characters.
function packedCondition(length: number): string {
  const head = `if (a && b${" || v".repeat(20)} || `;
  const tail = ") run();";
  return `${head}${"z".repeat(length - head.length - tail.length)}${tail}`;
}

function stringConst(length: number): string {
  const prefix = 'const message = "';
  return `${prefix}${"x".repeat(length - prefix.length - 2)}";`;
}

const longLogicWithStepId = `step(\`land-\${id}\`, ${"(alpha && beta) || (gamma ?? delta), ".repeat(7)}omega);`;
const longImport = `import { ${Array.from({ length: 24 }, (_, i) => `name${i}`).join(", ")} } from "./a-long-module-name.js";`;
const longComment = `// ${"word ".repeat(60)}`;
const longJsdoc = `/**\n * ${"word ".repeat(60)}\n */\nconst a = 1;`;

ruleTester.run("max-line-length", maxLineLength, {
  valid: [
    { name: "a 200-character code line passes", code: packedCondition(200), options: [{ max: 200 }] },
    { name: "a 260-character line that is one string literal assigned to a const passes", code: stringConst(260) },
    { name: "a 240-character import declaration passes", code: longImport },
    { name: "a 300-character line comment passes", code: longComment },
    { name: "a 300-character JSDoc line passes", code: longJsdoc },
    { name: "a long re-export passes", code: longImport.replace("import", "export") },
  ],
  invalid: [
    {
      name: "a 201-character packed condition reports",
      code: packedCondition(201),
      options: [{ max: 200 }],
      errors: [{ message: message(201), line: 1, column: 201 }],
    },
    {
      name: "a long call with a short template step id among long logic reports",
      code: longLogicWithStepId,
      errors: [{ message: message(longLogicWithStepId.length) }],
    },
    {
      name: "a smaller max option reports a 150-character line",
      code: packedCondition(150),
      options: [{ max: 120 }],
      errors: [{ message: message(150, 120) }],
    },
  ],
});
