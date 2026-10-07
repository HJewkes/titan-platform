import { noCommentedCode } from "./no-commented-code.js";
import { ruleTester, tsRuleTester } from "./test-fixtures.js";

const message = "This comment is code. Delete it; git history keeps it. If it explains why, rewrite it as a sentence.";
const flagged = (name: string, code: string, line = 1) => ({ name, code, errors: [{ message, line }] });

ruleTester.run("no-commented-code", noCommentedCode, {
  valid: [
    { name: "prose: a sentence", code: "// Retry once because the socket may be half closed." },
    { name: "prose: a single word", code: "// done" },
    { name: "prose: a bare string", code: '// "legacy"' },
    { name: "prose: a label-like note", code: "// note: this is deliberate" },
    { name: "prose: a sentence in a block comment", code: "/* Keeps the order stable for callers. */" },
    { name: "prose: a multi-line paragraph", code: "// First we load the file.\n// Then we parse it." },
    { name: "prose: a sentence ending in a period", code: "// Done." },
    { name: "jsdoc: a plain description", code: "/** Returns the sum. */" },
    { name: "jsdoc: tags", code: "/**\n * @param a first\n * @returns total\n */" },
    { name: "jsdoc: an @example block", code: "/**\n * @example\n * add(1, 2);\n * const x = add(3, 4);\n */" },
    { name: "jsdoc: one line holding code", code: "/** const x = 1; */" },
    { name: "jsdoc: before a function", code: "/** foo(bar); */\nfunction f() {}" },
    { name: "prose: a hyphenated word", code: "// read-only" },
    { name: "prose: arithmetic note", code: "// 100 - 75" },
    { name: "prose: a comparison note", code: "// utilization > 0" },
    { name: "prose: a manual page reference", code: "// sudo(8)" },
    { name: "prose: a list of names", code: "// fetchUser, parseConfig, safeParse" },
    { name: "prose: the keywords this and yield", code: "// this\n\n// yield" },
    { name: "prose: names inside an empty call", code: "fn(/* width, height */);" },
    { name: "prose: trailing comments on adjacent code lines are not joined", code: "const a = 1; // first\nconst b = 2; // (second)" },
    { name: "jsdoc: an import in an example", code: '/**\n * @example\n * import { y } from "z";\n */' },
    { name: "jsdoc: a one-line type cast", code: "const a = /** @type {Foo} */ (b);" },
    { name: "directive: eslint-disable-next-line", code: "// eslint-disable-next-line no-console\nconsole.log(1);" },
    { name: "directive: eslint-disable block", code: "/* eslint-disable no-console */" },
    { name: "directive: eslint-enable", code: "/* eslint-enable */" },
    { name: "directive: @ts-expect-error", code: "// @ts-expect-error foo(bar);\nconst a = 1;" },
    { name: "directive: istanbul ignore", code: "/* istanbul ignore next */\nconst a = 1;" },
    { name: "directive: c8 ignore", code: "/* c8 ignore next */\nconst a = 1;" },
    { name: "directive: v8 ignore", code: "/* v8 ignore next */\nconst a = 1;" },
    { name: "directive: prettier-ignore", code: "// prettier-ignore\nconst a = 1;" },
    { name: "directive: shebang", code: "#!/usr/bin/env node\nconst a = 1;" },
    { name: "directive: triple-slash reference", code: '/// <reference types="node" />\nconst a = 1;' },
  ],
  invalid: [
    flagged("a call statement", "// foo(bar);"),
    flagged("a declaration", "// const x = 1;"),
    flagged("an if statement", "// if (a) { b(); }"),
    flagged("a return statement", "// return x;"),
    flagged("an import", '// import { y } from "z";'),
    flagged("an assignment without a semicolon", "// x = y"),
    flagged("a call without a semicolon", "// foo()"),
    flagged("a block comment holding code", "/* const x = 1; */"),
    flagged("a multi-line block comment", "/*\nconst x = 1;\nfoo(x);\n*/"),
    {
      name: "consecutive line comments forming one statement report once",
      code: "// if (a) {\n//   b();\n// }",
      errors: [{ message, line: 1, endLine: 3 }],
    },
    flagged("code after a prose line is reported on its own line", "// Retry later.\n// foo(bar);", 2),
    flagged("a star-prefixed block comment holding code", "/*\n * const x = 1;\n * foo(x);\n */"),
    flagged("a bare identifier ending in a semicolon", "// done;"),
    flagged("an increment", "// i++"),
    flagged("commented code before real code", "// await run();\nconst a = 1;"),
  ],
});

const keywordCases = {
  valid: [
    { name: "a lone continue in an empty catch", code: "try { a(); } catch {\n  // continue\n}" },
    { name: "a lone break in an empty catch", code: "try { a(); } catch {\n  // break\n}" },
    { name: "a lone return in an empty catch", code: "try { a(); } catch {\n  // return\n}" },
    { name: "a lone debugger note", code: "// debugger" },
    { name: "a type-argument note", code: "// Map<string, number>" },
  ],
  invalid: [
    flagged("a continue with a semicolon", "// continue;"),
    flagged("a return with a value", "// return x"),
    flagged("a break with a semicolon", "// break;"),
    flagged("a call under this parser", "// foo(bar);"),
  ],
};

ruleTester.run("no-commented-code with the default parser", noCommentedCode, keywordCases);
tsRuleTester.run("no-commented-code with typescript-eslint", noCommentedCode, keywordCases);
