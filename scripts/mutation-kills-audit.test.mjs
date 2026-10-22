import { describe, expect, it } from "vitest";
import { testFileOf, testNamesOf, unmatchedKills } from "./mutation-kills-audit.mjs";

const report = (...fullNames) => ({ testResults: [{ name: "/repo/src/a.test.ts", assertionResults: fullNames.map((fullName) => ({ fullName, status: "passed" })) }] });
const sidecar = (...kills) => ({ v: 1, mutations: [{ name: "flip", file: "src/a.ts", find: "x", replace: "y", kills }] });

describe("unmatchedKills", () => {
  it("names a kill given by its bare title when the test sits under a describe", () => {
    const names = testNamesOf(report("adder adds", "adder subtracts"));

    expect(unmatchedKills(sidecar("adds", "adder subtracts"), names)).toEqual([{ mutation: "flip", kill: "adds" }]);
  });

  it("passes every kill that names a full title", () => {
    expect(unmatchedKills(sidecar("adder adds"), testNamesOf(report("adder adds")))).toEqual([]);
  });
});

describe("testNamesOf", () => {
  it("joins ancestor titles and the title when the report has no full name", () => {
    const names = testNamesOf({ testResults: [{ assertionResults: [{ ancestorTitles: ["adder"], title: "adds" }] }] });

    expect([...(names ?? [])]).toEqual(["adder adds"]);
  });

  it("is null for a file that collected no tests, so an unloaded file never reads as all kills unmatched", () => {
    expect(testNamesOf({ testResults: [{ assertionResults: [] }] })).toBeNull();
  });
});

describe("testFileOf", () => {
  it("pairs a sidecar with the one test file beside it", () => {
    expect(testFileOf("src/a.test.mutations.json", (path) => path === "src/a.test.ts")).toBe("src/a.test.ts");
  });

  it("is null when two test files share the stem", () => {
    expect(testFileOf("src/a.test.mutations.json", (path) => path !== "src/a.test.mjs")).toBeNull();
  });
});
