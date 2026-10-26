import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_MUTATION_NAME, MAX_MUTATIONS } from "../packages/fix-proof/dist/index.js";
import { specProblem, testFileOf, testNamesOf, unmatchedKills } from "./mutation-kills-audit.mjs";

const report = (...fullNames) => ({ testResults: [{ name: "/repo/src/a.test.ts", assertionResults: fullNames.map((fullName) => ({ fullName, status: "passed" })) }] });
const sidecar = (...kills) => ({ v: 1, mutations: [{ name: "flip", file: "src/a.ts", find: "x", replace: "y", kills }] });
const mutant = (name) => ({ name, file: "src/a.ts", find: "x", replace: "y", kills: ["adder adds"] });
const specText = (...names) => JSON.stringify({ v: 1, mutations: names.map(mutant) });
const PATH = "src/a.test.mutations.json";

describe("specProblem", () => {
  it("accepts a sidecar fix-proof would run", () => {
    expect(specProblem(PATH, specText("flip", "drop"))).toBeNull();
  });

  it("refuses a mutation name over fix-proof's length cap, naming the file and the mutation", () => {
    const problem = specProblem(PATH, specText("flip", "n".repeat(MAX_MUTATION_NAME + 1)));

    expect(problem).toBe(`${PATH}: mutation spec: mutations[1].name is over ${MAX_MUTATION_NAME} characters`);
  });

  it("refuses a sidecar holding more mutants than fix-proof's cap", () => {
    const names = Array.from({ length: MAX_MUTATIONS + 1 }, (_, index) => `m${index}`);

    expect(specProblem(PATH, specText(...names))).toBe(`${PATH}: mutation spec: spec.mutations must hold 1 to ${MAX_MUTATIONS} mutations`);
  });

  it("refuses text that is not JSON instead of throwing", () => {
    expect(specProblem(PATH, "{")).toMatch(/^src\/a\.test\.mutations\.json: mutation spec: /);
  });
});

describe("the audit command", () => {
  it("fails a sidecar fix-proof refuses and still reports its kill problems", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutation-kills-audit-test-"));
    try {
      const path = join(dir, "a.test.mutations.json");
      writeFileSync(path, specText("n".repeat(MAX_MUTATION_NAME + 1)));

      const run = spawnSync(process.execPath, [fileURLToPath(new URL("./mutation-kills-audit.mjs", import.meta.url)), path], { encoding: "utf8" });

      expect(run.status).toBe(1);
      expect(run.stdout.split("\n")).toEqual([
        `${path}: mutation spec: mutations[0].name is over ${MAX_MUTATION_NAME} characters`,
        `${path}: no single test file beside it`,
        "1 sidecars, 2 problems",
        "",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
