import { describe, expect, it } from "vitest";
import { changedLines, missedChange, touchedTests } from "./mutation-kills-touched.mjs";

const SOURCE = [
  'import { getButton } from "./get-button.js";', // 1
  "const press = (label) => getButton(label);", // 2
  "const ship = () => press(\"Ship\");", // 3
  'describe("a round", () => {', // 4
  '  it("ships", () => {', // 5
  "    ship();", // 6
  "  });", // 7
  '  it("ignores a modifier", () => {', // 8
  "    expect(1).toBe(1);", // 9
  "  });", // 10
  "});", // 11
].join("\n");

const sidecar = (...kills) => ({ v: 1, mutations: [{ name: "flip", file: "src/a.ts", find: "x", replace: "y", kills }] });

describe("touchedTests", () => {
  it("names a test whose body holds a changed line, under its describe titles", () => {
    expect([...touchedTests(SOURCE, new Set([9]))]).toEqual(["a round ignores a modifier"]);
  });

  it("follows a changed helper through the helpers that call it to the tests that call those", () => {
    expect([...touchedTests(SOURCE, new Set([2]))]).toEqual(["a round ships"]);
  });

  it("touches no test when only an import changed", () => {
    expect(touchedTests(SOURCE, new Set([1])).size).toBe(0);
  });
});

describe("missedChange", () => {
  it("flags a sidecar that only kills a test the diff left alone (the rounds.test.tsx case on #2219)", () => {
    expect(missedChange(sidecar("a round ignores a modifier"), new Set(["a round ships"]))).toEqual(expect.stringContaining("no kill names a test the diff touches"));
  });

  it("passes a sidecar with one kill among the touched tests", () => {
    expect(missedChange(sidecar("a round ignores a modifier", "a round ships"), new Set(["a round ships"]))).toBeNull();
  });

  it("asks nothing of a diff that touches no test", () => {
    expect(missedChange(sidecar("a round ships"), new Set())).toBeNull();
  });
});

describe("changedLines", () => {
  it("reads the new-side lines of each hunk and nothing from a pure deletion", () => {
    const diff = "@@ -3 +3 @@ x\n-a\n+b\n@@ -10,2 +10,0 @@ y\n@@ -20,0 +19,2 @@ z\n";

    expect([...changedLines(diff)]).toEqual([3, 19, 20]);
  });
});
