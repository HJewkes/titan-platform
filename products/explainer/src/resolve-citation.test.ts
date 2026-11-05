import { describe, expect, it } from "vitest";
import { citationRefusals, codeSource } from "./resolve-citation.js";
import { oneBeat, resolveFixture, visual } from "./resolve-fixtures.test-helpers.js";

const source = codeSource(resolveFixture("code.json"));
const codeBeat = (code: Record<string, unknown>) => oneBeat("HOW", { visual: visual({ job: "code-proof", code }) });

describe("code beat citations", () => {
  it("accepts a code beat whose range and highlights lie inside the cited file", () => {
    expect(citationRefusals([codeBeat({ file: "src/desk.ts", lines: [4, 8], highlight: [5, 6] })], source)).toEqual([]);
  });

  it("accepts a range that ends on the file's last line", () => {
    expect(citationRefusals([codeBeat({ file: "src/desk.ts", lines: [10, 12] })], source)).toEqual([]);
  });

  it("refuses a code beat citing a line past the end of the file", () => {
    expect(citationRefusals([codeBeat({ file: "src/desk.ts", lines: [10, 13] })], source)).toEqual([
      { beat: "b1", code: "E-RESOLVE-CITATION", detail: "past-eof: range ends at 13 but src/desk.ts has 12 lines" },
    ]);
  });

  it("refuses a code beat citing a file the code artifact does not hold", () => {
    expect(citationRefusals([codeBeat({ file: "src/missing.ts", lines: [1, 2] })], source)).toMatchObject([{ code: "E-RESOLVE-CITATION", detail: "path-unreadable: src/missing.ts could not be read" }]);
  });

  it("refuses a highlight outside the cited range", () => {
    expect(citationRefusals([codeBeat({ file: "src/desk.ts", lines: [4, 8], highlight: [9] })], source)).toMatchObject([{ detail: "highlights line 9 outside src/desk.ts:4-8" }]);
  });

  it("refuses a code beat when the run has no code artifact, and ignores beats without code", () => {
    expect(citationRefusals([codeBeat({ file: "src/desk.ts", lines: [4, 8] })], undefined)).toMatchObject([{ beat: "b1", code: "E-RESOLVE-CITATION" }]);
    expect(citationRefusals([oneBeat()], undefined)).toEqual([]);
  });
});
