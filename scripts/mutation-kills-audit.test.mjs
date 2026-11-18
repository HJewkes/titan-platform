import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_MUTATION_NAME, MAX_MUTATIONS } from "../packages/fix-proof/dist/index.js";
import { findProblems, sidecarsOfChanged, specProblem, testFileOf, testNamesOf, unmatchedKills } from "./mutation-kills-audit.mjs";

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

describe("findProblems", () => {
  const config = { tests: [], carry: [] };
  const text = specText("flip");

  it("a sidecar whose find is absent from its target fails the audit", () => {
    const problems = findProblems(PATH, text, () => "const y = 1;", config);

    expect(problems).toEqual([`${PATH}: mutation flip: find does not occur in src/a.ts at head`]);
  });

  it("names a target that does not exist", () => {
    expect(findProblems(PATH, text, () => null, config)).toEqual([`${PATH}: mutation flip: src/a.ts does not exist at head`]);
  });

  it("refuses a find that occurs more than once", () => {
    expect(findProblems(PATH, text, () => "x x", config)).toEqual([`${PATH}: mutation flip: find occurs more than once in src/a.ts at head`]);
  });

  it("accepts a find that occurs once in its target", () => {
    expect(findProblems(PATH, text, () => "const x = 1;", config)).toEqual([]);
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

describe("the --finds run", () => {
  it("fails a tracked-style sidecar whose find is absent from its target, without running tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutation-kills-audit-test-"));
    try {
      const path = join(dir, "a.test.mutations.json");
      writeFileSync(path, specText("flip"));

      const run = spawnSync(process.execPath, [fileURLToPath(new URL("./mutation-kills-audit.mjs", import.meta.url)), "--finds", path], { encoding: "utf8" });

      expect(run.status).toBe(1);
      expect(run.stdout.split("\n")).toEqual([`${path}: mutation flip: src/a.ts does not exist at head`, "1 sidecars, 1 problems", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the --finds run and the mutation cap", () => {
  const runFinds = (count) => {
    const dir = mkdtempSync(join(tmpdir(), "mutation-kills-audit-test-"));
    try {
      const path = join(dir, "a.test.mutations.json");
      writeFileSync(path, specText(...Array.from({ length: count }, (_, index) => `m${index}`)));
      const run = spawnSync(process.execPath, [fileURLToPath(new URL("./mutation-kills-audit.mjs", import.meta.url)), "--finds", path], { encoding: "utf8" });
      return { path, lines: run.stdout.split("\n") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("fails a sidecar over the cap, naming the file and the cap", () => {
    const { path, lines } = runFinds(MAX_MUTATIONS + 1);

    expect(lines).toContain(`${path}: mutation spec: spec.mutations must hold 1 to ${MAX_MUTATIONS} mutations`);
  });

  it("raises no cap problem for a sidecar at the cap", () => {
    const { lines } = runFinds(MAX_MUTATIONS);

    expect(lines.filter((line) => line.includes("must hold"))).toEqual([]);
  });
});

describe("the sidecar:kills run", () => {
  // The fixture sits under scripts/ because the audit runs vitest on the paired test file, and only the repo's own
  // config includes it; the directory is removed after each run.
  const runKills = (kill) => {
    const dir = mkdtempSync(join(fileURLToPath(new URL(".", import.meta.url)), "kills-fixture-"));
    try {
      writeFileSync(join(dir, "a.mjs"), "export const x = 1;\n");
      writeFileSync(join(dir, "a.test.mjs"), 'import { it } from "vitest";\nit("adds", () => {});\n');
      const mutation = { name: "flip", file: relative(process.cwd(), join(dir, "a.mjs")), find: "x = 1", replace: "x = 2", kills: [kill] };
      const path = join(dir, "a.test.mutations.json");
      writeFileSync(path, JSON.stringify({ v: 1, mutations: [mutation] }));
      const run = spawnSync("pnpm", ["run", "--silent", "sidecar:kills", path], { encoding: "utf8" });
      return { status: run.status, lines: run.stdout.split("\n"), path };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("exits non-zero for a kill that names no test", () => {
    const { status, lines, path } = runKills("no such test");

    expect(status).toBe(1);
    expect(lines).toContain(`${path}: mutation "flip" kills "no such test", which names no test`);
  });

  it("exits zero when every kill names a test", () => {
    const { status, lines } = runKills("adds");

    expect(status).toBe(0);
    expect(lines).toContain("1 sidecars, 0 problems");
  });
});

describe("sidecarsOfChanged", () => {
  const exists = (path) => path === "src/a.test.mutations.json";

  it("skips a changed test file that has no sidecar, since sidecars are optional", () => {
    expect(sidecarsOfChanged(["src/b.test.ts", "README.md"], exists)).toEqual([]);
  });

  it("names the sidecar beside each changed test file that has one", () => {
    expect(sidecarsOfChanged(["src/a.test.mjs", "src/b.test.tsx"], exists)).toEqual(["src/a.test.mutations.json"]);
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
