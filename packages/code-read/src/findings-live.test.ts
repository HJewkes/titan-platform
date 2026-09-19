import { describe, expect, it } from "vitest";
import { specifierLines } from "./findings-live.js";

describe("locating an import's line", () => {
  it("matches the specifier in double, single, or backtick quotes, and nothing that merely contains it", () => {
    const lines = ['import a from "./a.js";', "import b from './a.js';", "const c = import(`./a.js`);", 'import d from "./a.jsx";', "// ./a.js"];

    expect(specifierLines(lines, "./a.js")).toEqual([
      { startLine: 1, endLine: 1 }, { startLine: 2, endLine: 2 }, { startLine: 3, endLine: 3 },
    ]);
  });
});
