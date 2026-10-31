import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnExec, type Exec } from "./exec.js";
import { classifyDecoded, judge, type JudgeReports } from "./judge.js";
import { GIT_SAFETY } from "./context.js";
import {
  FIXED,
  git,
  makeRepo,
  parsed,
  REAL_TEST,
  removeRepos,
  VACUOUS_TEST,
  type Repo,
} from "./repo.test-helpers.js";
import { provedByMutants } from "./result-line.js";
import { encodeError, encodeMutantsReport, encodeReport } from "./transport.js";

afterEach(removeRepos);

function report(files: Record<string, "passed" | "failed">): string {
  return encodeReport({
    testResults: Object.entries(files).map(([name, status]) => ({
      name,
      status,
      assertionResults: [
        {
          fullName: "adds",
          status,
          failureMessages: status === "failed" ? ["expected 3, got -1"] : [],
        },
      ],
    })),
  });
}

function forgeOver(repo: Repo, at: string, edit: () => void): string {
  git(repo.dir, ["checkout", "-q", "--detach", at]);
  edit();
  git(repo.dir, ["commit", "-q", "-m", "forged"]);
  const forged = git(repo.dir, ["rev-parse", "HEAD"]);
  git(repo.dir, ["checkout", "-q", "main"]);
  return forged;
}

const forgeries: Record<string, (repo: Repo, head: string) => void> = {
  "a head whose test is gone": (repo, head) => {
    const forged = forgeOver(repo, head, () =>
      git(repo.dir, ["rm", "-q", "src/math.test.ts"])
    );
    git(repo.dir, ["replace", head, forged]);
  },
  "a base whose config selects no tests": (repo) => {
    const forged = forgeOver(repo, repo.base, () => {
      fs.writeFileSync(
        path.join(repo.dir, ".github/fix-proof.json"),
        JSON.stringify({ tests: ["nothing/**"] })
      );
      git(repo.dir, ["add", "-A"]);
    });
    git(repo.dir, ["replace", repo.base, forged]);
  },
};

function fixPr(): { repo: Repo; head: string } {
  const repo = makeRepo();
  return {
    repo,
    head: repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST }),
  };
}

async function verdictFor(reports: JudgeReports, exec?: Exec) {
  const { repo, head } = fixPr();
  return parsed(
    await judge({
      repo: repo.dir,
      base: repo.base,
      head,
      reports,
      ...(exec ? { exec } : {}),
    })
  );
}

describe("classifyDecoded", () => {
  it("classifyDecoded keeps every test past the 4 KB line cap", () => {
    const names = Array.from(
      { length: 200 },
      (_, index) =>
        `adds number ${index} with a long descriptive name to pad the report`
    );
    const run = (status: "passed" | "failed") =>
      encodeReport({
        testResults: [
          {
            name: "src/math.test.ts",
            status,
            assertionResults: names.map((fullName) => ({
              fullName,
              status,
              failureMessages:
                status === "failed" ? ["expected 3, got -1"] : [],
            })),
          },
        ],
      });

    const classification = classifyDecoded(
      {
        tests: ["src/math.test.ts"],
        carried: [],
        deletedTests: [],
        overlayRemovals: [],
        mutations: [],
        source: [],
        config: { tests: [], carry: [], runtime: [] },
        configEdited: false,
      },
      { base: run("failed"), baseRerun: run("failed"), head: run("passed") }
    );

    expect(classification.verdict).toBe("reproduced");
    expect(classification.tests).toHaveLength(200);
    expect(
      classification.tests.every((test) => test.class === "reproduces")
    ).toBe(true);
    expect(JSON.stringify(classification).length).toBeGreaterThan(4096);
  });
});

describe("judge", () => {
  it("judge runs no command but git", async () => {
    const files: string[] = [];
    const exec: Exec = (file, args, options) => {
      files.push(file);
      return spawnExec(file, args, options);
    };
    const failed = report({ "src/math.test.ts": "failed" });

    const result = await verdictFor(
      {
        base: failed,
        baseRerun: failed,
        head: report({ "src/math.test.ts": "passed" }),
      },
      exec
    );

    expect(result.verdict).toBe("reproduced");
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files)).toEqual(new Set(["git"]));
  });

  it("judge ignores report entries outside its own plan", async () => {
    const base = report({
      "src/math.test.ts": "passed",
      "src/forged.test.ts": "failed",
    });
    const head = report({
      "src/math.test.ts": "passed",
      "src/forged.test.ts": "passed",
    });

    const result = await verdictFor({ base, baseRerun: base, head });

    expect(result.verdict).toBe("vacuous");
    expect(JSON.stringify(result)).not.toContain("forged");
  });

  it("reads the base rerun only after a vacuous first run", async () => {
    const passed = report({ "src/math.test.ts": "passed" });

    const result = await verdictFor({
      base: passed,
      baseRerun: report({ "src/math.test.ts": "failed" }),
      head: passed,
    });

    expect(result.verdict).toBe("reproduced");
  });

  it("a missing head report is a named error verdict", async () => {
    const failed = report({ "src/math.test.ts": "failed" });

    const result = await verdictFor({ base: failed, baseRerun: failed });

    expect(result).toMatchObject({
      verdict: "error",
      error: "head: missing report",
    });
  });

  it("passes an exec side's own error through unprefixed", async () => {
    const result = await verdictFor({
      base: encodeError("base: build failed (exit 3)"),
      head: report({ "src/math.test.ts": "passed" }),
    });

    expect(result).toMatchObject({
      verdict: "error",
      error: "base: build failed (exit 3)",
    });
  });

  it.each(Object.keys(forgeries))(
    "a head that wrote refs/replace for %s before the judge runs cannot change the verdict",
    async (forgery) => {
      const { repo, head } = fixPr();
      forgeries[forgery]!(repo, head);
      const failed = report({ "src/math.test.ts": "failed" });
      const reports = {
        base: failed,
        baseRerun: failed,
        head: report({ "src/math.test.ts": "passed" }),
      };

      const result = parsed(
        await judge({ repo: repo.dir, base: repo.base, head, reports })
      );

      expect(result).toMatchObject({ verdict: "reproduced", head });
    }
  );

  it("every git call the judge makes ignores replace refs and pathspec magic", async () => {
    const calls: (readonly string[])[] = [];
    const exec: Exec = (file, args, options) => {
      calls.push(args);
      return spawnExec(file, args, options);
    };
    const failed = report({ "src/math.test.ts": "failed" });

    await verdictFor(
      {
        base: failed,
        baseRerun: failed,
        head: report({ "src/math.test.ts": "passed" }),
      },
      exec
    );

    expect(calls.length).toBeGreaterThan(0);
    calls.forEach((args) =>
      expect(args.slice(0, GIT_SAFETY.length)).toEqual([...GIT_SAFETY])
    );
  });

  it("prints a no-tests line without reading any report", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED });

    expect(
      parsed(
        await judge({ repo: repo.dir, base: repo.base, head, reports: {} })
      ).verdict
    ).toBe("no-tests");
  });
});

describe("judge with mutation specs", () => {
  const SPEC = "src/math.test.mutations.json";
  const mutation = {
    name: "zero",
    file: "src/math.ts",
    find: "a - b",
    replace: "a - b + 1",
    kills: ["adds zero"],
  };
  const specText = (find = mutation.find) =>
    JSON.stringify({ v: 1, mutations: [{ ...mutation, find }] });

  function zeroReport(status: "passed" | "failed"): unknown {
    const failureMessages =
      status === "failed"
        ? ["AssertionError: expected 1 to be +0 // Object.is equality"]
        : [];
    return {
      testResults: [
        {
          name: "src/math.test.ts",
          status,
          assertionResults: [
            { fullName: "adds zero", status, failureMessages },
          ],
        },
      ],
    };
  }

  const reports = (mutants?: string): JudgeReports => {
    const passed = encodeReport(zeroReport("passed"));
    return {
      base: passed,
      baseRerun: passed,
      head: passed,
      ...(mutants === undefined ? {} : { mutants }),
    };
  };
  const killedMutants = encodeMutantsReport({
    baseline: zeroReport("passed"),
    runs: [
      { spec: SPEC, name: "zero", built: true, report: zeroReport("failed") },
    ],
  });

  async function judgeHead(files: Record<string, string>, mutants?: string) {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.test.ts": VACUOUS_TEST, ...files });
    return parsed(
      await judge({
        repo: repo.dir,
        base: repo.base,
        head,
        reports: reports(mutants),
      })
    );
  }

  it("attaches killed mutants to a vacuous tests-only diff", async () => {
    const result = await judgeHead(
      { [SPEC]: specText(), ".changeset/x.md": "---\n---\n" },
      killedMutants
    );

    expect(result.verdict).toBe("vacuous");
    expect(result.mutants).toEqual({
      verdict: "killed",
      results: [{ spec: SPEC, name: "zero", outcome: "killed" }],
      uncovered: [],
    });
    expect(provedByMutants(result)).toBe(true);
  });

  describe("a diff that changes only the spec beside an unchanged test", () => {
    const judgeSpecOnly = async (
      baseFiles: Record<string, string>,
      mutants: string
    ) => {
      const repo = makeRepo({}, undefined, baseFiles);
      const head = repo.commit({
        [SPEC]: specText(),
        ".changeset/x.md": "---\n---\n",
      });
      return parsed(
        await judge({
          repo: repo.dir,
          base: repo.base,
          head,
          reports: reports(mutants),
        })
      );
    };

    it("runs the sibling test and judges the spec's mutants", async () => {
      const result = await judgeSpecOnly(
        { "src/math.test.ts": VACUOUS_TEST },
        killedMutants
      );

      expect(result.verdict).toBe("vacuous");
      expect(result.tests).toMatchObject([
        { file: "src/math.test.ts", name: "adds zero" },
      ]);
      expect(result.mutants).toEqual({
        verdict: "killed",
        results: [{ spec: SPEC, name: "zero", outcome: "killed" }],
        uncovered: [],
      });
      expect(provedByMutants(result)).toBe(true);
    });

    it("a surviving mutant leaves the spec-only diff unproved", async () => {
      const survived = encodeMutantsReport({
        baseline: zeroReport("passed"),
        runs: [
          {
            spec: SPEC,
            name: "zero",
            built: true,
            report: zeroReport("passed"),
          },
        ],
      });

      const result = await judgeSpecOnly(
        { "src/math.test.ts": VACUOUS_TEST },
        survived
      );

      expect(result.mutants).toMatchObject({
        verdict: "not-killed",
        results: [{ spec: SPEC, name: "zero", outcome: "survived" }],
      });
      expect(provedByMutants(result)).toBe(false);
    });

    it("with no sibling test at head stays a no-tests verdict with no mutants", async () => {
      const result = await judgeSpecOnly({}, killedMutants);

      expect(result.verdict).toBe("no-tests");
      expect(result.mutants).toBeUndefined();
    });
  });

  describe("a changed test file with no spec of its own", () => {
    const GUARD = "src/guard.test.ts";
    const guardTest = (body: string) => `test("denies", () => { ${body} });\n`;
    const allPassed = (others: readonly string[]): string => {
      const file = (name: string, test: string) => ({
        name,
        status: "passed",
        assertionResults: [
          { fullName: test, status: "passed", failureMessages: [] },
        ],
      });
      return encodeReport({
        testResults: [
          file("src/math.test.ts", "adds zero"),
          ...others.map((other) => file(other, "denies")),
        ],
      });
    };
    const judgeOver = async (
      baseFiles: Record<string, string>,
      headFiles: Record<string, string>,
      others: readonly string[] = [GUARD]
    ) => {
      const repo = makeRepo({}, undefined, baseFiles);
      const head = repo.commit(headFiles);
      const passed = allPassed(others);
      return parsed(
        await judge({
          repo: repo.dir,
          base: repo.base,
          head,
          reports: {
            base: passed,
            baseRerun: passed,
            head: passed,
            mutants: killedMutants,
          },
        })
      );
    };

    it("a spec borrowed from an unchanged sibling test proves nothing about the gutted test the PR changed", async () => {
      const result = await judgeOver(
        {
          "src/math.test.ts": VACUOUS_TEST,
          [GUARD]: guardTest("expect(1).toBe(1); expect(2).toBe(2);"),
        },
        { [GUARD]: guardTest(""), [SPEC]: specText() }
      );

      expect(result.verdict).toBe("vacuous");
      expect(result.mutants).toMatchObject({
        verdict: "not-killed",
        uncovered: [GUARD],
      });
      expect(provedByMutants(result)).toBe(false);
    });

    it("one of two changed test files without a spec leaves the PR unproved", async () => {
      const result = await judgeOver(
        {},
        {
          "src/math.test.ts": VACUOUS_TEST,
          [GUARD]: guardTest("expect(1).toBe(1);"),
          [SPEC]: specText(),
        }
      );

      expect(result.mutants).toMatchObject({
        verdict: "not-killed",
        uncovered: [GUARD],
      });
      expect(provedByMutants(result)).toBe(false);
    });

    it("a changed test under a carried test-support path needs no spec, since no mutation may target its helpers", async () => {
      const SUPPORT = "pkg/src/test-support/x.test.ts";

      const result = await judgeOver(
        {},
        {
          "src/math.test.ts": VACUOUS_TEST,
          [SUPPORT]: guardTest("expect(1).toBe(1);"),
          [SPEC]: specText(),
        },
        [SUPPORT]
      );

      expect(result.mutants).toEqual({
        verdict: "killed",
        results: [{ spec: SPEC, name: "zero", outcome: "killed" }],
        uncovered: [],
      });
    });

    it("a changed carried test that imports non-carried source still needs a spec, since a mutation may target that source", async () => {
      const PROBE = "pkg/src/test-support/z.test.ts";
      const probe = `import { foo } from "../foo.js";\n${guardTest(
        "expect(foo).toBe(1);"
      )}`;

      const result = await judgeOver(
        { "pkg/src/foo.ts": "export const foo = 1;\n" },
        {
          "src/math.test.ts": VACUOUS_TEST,
          [PROBE]: probe,
          [SPEC]: specText(),
        },
        [PROBE]
      );

      expect(result.mutants).toMatchObject({
        verdict: "not-killed",
        uncovered: [PROBE],
      });
    });

    it("a changed test outside the carry paths with no spec stays uncovered", async () => {
      const PLAIN = "pkg/src/y.test.ts";

      const result = await judgeOver(
        {},
        {
          "src/math.test.ts": VACUOUS_TEST,
          [PLAIN]: guardTest("expect(1).toBe(1);"),
          [SPEC]: specText(),
        },
        [PLAIN]
      );

      expect(result.mutants).toMatchObject({
        verdict: "not-killed",
        uncovered: [PLAIN],
      });
    });
  });

  describe("a test the PR removes from the tests", () => {
    const GUARD = "src/guard.test.ts";
    const judgeRemoving = async (remove: (dir: string) => void) => {
      const repo = makeRepo({}, undefined, {
        "src/math.test.ts": VACUOUS_TEST,
        [GUARD]: `test("denies", () => { expect(1).toBe(1); });\n`,
      });
      remove(repo.dir);
      const head = repo.commit({
        "src/math.test.ts": `${VACUOUS_TEST}// touched\n`,
        [SPEC]: specText(),
      });
      return parsed(
        await judge({
          repo: repo.dir,
          base: repo.base,
          head,
          reports: reports(killedMutants),
        })
      );
    };

    it("a deleted test beside a killed spec on an untouched sibling leaves the PR unproved", async () => {
      const result = await judgeRemoving((dir) =>
        git(dir, ["rm", "-q", GUARD])
      );

      expect(result).toMatchObject({
        verdict: "vacuous",
        deletedTests: [GUARD],
      });
      expect(result.mutants).toBeUndefined();
      expect(provedByMutants(result)).toBe(false);
    });

    it("a test renamed into a carried fixture counts as deleted and leaves the PR unproved", async () => {
      const result = await judgeRemoving((dir) => {
        fs.mkdirSync(path.join(dir, "src/fixtures"));
        git(dir, ["mv", GUARD, "src/fixtures/guard.ts"]);
      });

      expect(result).toMatchObject({
        verdict: "vacuous",
        deletedTests: [GUARD],
      });
      expect(result.mutants).toBeUndefined();
      expect(provedByMutants(result)).toBe(false);
    });
  });

  it("attaches no mutants when the diff also changes source", async () => {
    const result = await judgeHead(
      {
        [SPEC]: specText(),
        "src/math.ts":
          "export const add = (a: number, b: number) => a - b;\n// touched\n",
      },
      killedMutants
    );

    expect(result.mutants).toBeUndefined();
  });

  describe("a source diff whose spec kills tests the head no longer has", () => {
    const RENAMED = ["math adds", "math adds negatives", "math adds zero"];
    const sourceSpec = (kills: readonly string[]) =>
      JSON.stringify({
        v: 1,
        mutations: [
          {
            name: "minus",
            file: "src/math.ts",
            find: "a + b",
            replace: "a - b",
            kills: [kills[0]],
          },
          {
            name: "first",
            file: "src/math.ts",
            find: "(a: number",
            replace: "(_: number",
            kills: [kills[1]],
          },
          {
            name: "second",
            file: "src/math.ts",
            find: "b: number)",
            replace: "_: number)",
            kills: [kills[2]],
          },
        ],
      });

    function namedReport(status: "passed" | "failed"): string {
      const failureMessages =
        status === "failed" ? ["AssertionError: expected -1 to be 3"] : [];
      const assertionResults = RENAMED.map((fullName) => ({
        fullName,
        status,
        failureMessages,
      }));
      return encodeReport({
        testResults: [{ name: "src/math.test.ts", status, assertionResults }],
      });
    }

    async function judgeSourceDiff(kills: readonly string[]) {
      const repo = makeRepo();
      const head = repo.commit({
        "src/math.ts": FIXED,
        "src/math.test.ts": REAL_TEST,
        [SPEC]: sourceSpec(kills),
      });
      const failed = namedReport("failed");
      return parsed(
        await judge({
          repo: repo.dir,
          base: repo.base,
          head,
          reports: {
            base: failed,
            baseRerun: failed,
            head: namedReport("passed"),
          },
        })
      );
    }

    it("three stale kills turn a reproduced verdict into an error naming each kill", async () => {
      const result = await judgeSourceDiff([
        "adds",
        "adds negatives",
        "adds zero",
      ]);

      expect(result.verdict).toBe("error");
      expect(result.error).toMatch(/^mutation spec: /);
      expect(result.mutants?.verdict).toBe("error");
      for (const kill of ["adds", "adds negatives", "adds zero"])
        expect(result.mutants?.error).toContain(
          `kills ${JSON.stringify(kill)}, which names no test`
        );
      expect(result.mutants?.error).toContain(
        'did you mean "math adds negatives"?'
      );
    });

    it("kills that name head tests leave the reproduced verdict and attach no mutants", async () => {
      const result = await judgeSourceDiff(RENAMED);

      expect(result.verdict).toBe("reproduced");
      expect(result.mutants).toBeUndefined();
    });
  });

  it("attaches no mutants when the diff has no spec", async () => {
    expect((await judgeHead({}, killedMutants)).mutants).toBeUndefined();
  });

  it("a spec whose find does not occur once at the merge base is a mutants error, not a killed verdict", async () => {
    const result = await judgeHead(
      { [SPEC]: specText("a * b") },
      killedMutants
    );

    expect(result.verdict).toBe("vacuous");
    expect(result.mutants).toMatchObject({
      verdict: "error",
      error: expect.stringContaining("does not occur"),
    });
  });

  it("a spec with no test beside it is a mutants error", async () => {
    const result = await judgeHead(
      { "src/lonely.test.mutations.json": specText() },
      killedMutants
    );

    expect(result.mutants).toMatchObject({
      verdict: "error",
      error: expect.stringContaining("no single test file"),
    });
  });

  it("a missing mutants report is a mutants error and leaves the base-vs-head verdict alone", async () => {
    const result = await judgeHead({ [SPEC]: specText() });

    expect(result.verdict).toBe("vacuous");
    expect(result.mutants).toMatchObject({
      verdict: "error",
      error: "mutants: missing report",
    });
  });
});
