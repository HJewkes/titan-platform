import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnExec, type Exec } from "./exec.js";
import { judge, type JudgeReports } from "./judge.js";
import { GIT_SAFETY } from "./context.js";
import { FIXED, git, makeRepo, parsed, REAL_TEST, removeRepos, VACUOUS_TEST, type Repo } from "./repo.test-helpers.js";
import { encodeError, encodeMutantsReport, encodeReport } from "./transport.js";

afterEach(removeRepos);

function report(files: Record<string, "passed" | "failed">): string {
  return encodeReport({
    testResults: Object.entries(files).map(([name, status]) => ({
      name,
      status,
      assertionResults: [{ fullName: "adds", status, failureMessages: status === "failed" ? ["expected 3, got -1"] : [] }],
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
    const forged = forgeOver(repo, head, () => git(repo.dir, ["rm", "-q", "src/math.test.ts"]));
    git(repo.dir, ["replace", head, forged]);
  },
  "a base whose config selects no tests": (repo) => {
    const forged = forgeOver(repo, repo.base, () => {
      fs.writeFileSync(path.join(repo.dir, ".github/fix-proof.json"), JSON.stringify({ tests: ["nothing/**"] }));
      git(repo.dir, ["add", "-A"]);
    });
    git(repo.dir, ["replace", repo.base, forged]);
  },
};

function fixPr(): { repo: Repo; head: string } {
  const repo = makeRepo();
  return { repo, head: repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST }) };
}

async function verdictFor(reports: JudgeReports, exec?: Exec) {
  const { repo, head } = fixPr();
  return parsed(await judge({ repo: repo.dir, base: repo.base, head, reports, ...(exec ? { exec } : {}) }));
}

describe("judge", () => {
  it("judge runs no command but git", async () => {
    const files: string[] = [];
    const exec: Exec = (file, args, options) => {
      files.push(file);
      return spawnExec(file, args, options);
    };
    const failed = report({ "src/math.test.ts": "failed" });

    const result = await verdictFor({ base: failed, baseRerun: failed, head: report({ "src/math.test.ts": "passed" }) }, exec);

    expect(result.verdict).toBe("reproduced");
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files)).toEqual(new Set(["git"]));
  });

  it("judge ignores report entries outside its own plan", async () => {
    const base = report({ "src/math.test.ts": "passed", "src/forged.test.ts": "failed" });
    const head = report({ "src/math.test.ts": "passed", "src/forged.test.ts": "passed" });

    const result = await verdictFor({ base, baseRerun: base, head });

    expect(result.verdict).toBe("vacuous");
    expect(JSON.stringify(result)).not.toContain("forged");
  });

  it("reads the base rerun only after a vacuous first run", async () => {
    const passed = report({ "src/math.test.ts": "passed" });

    const result = await verdictFor({ base: passed, baseRerun: report({ "src/math.test.ts": "failed" }), head: passed });

    expect(result.verdict).toBe("reproduced");
  });

  it("a missing head report is a named error verdict", async () => {
    const failed = report({ "src/math.test.ts": "failed" });

    const result = await verdictFor({ base: failed, baseRerun: failed });

    expect(result).toMatchObject({ verdict: "error", error: "head: missing report" });
  });

  it("passes an exec side's own error through unprefixed", async () => {
    const result = await verdictFor({ base: encodeError("base: build failed (exit 3)"), head: report({ "src/math.test.ts": "passed" }) });

    expect(result).toMatchObject({ verdict: "error", error: "base: build failed (exit 3)" });
  });

  it.each(Object.keys(forgeries))("a head that wrote refs/replace for %s before the judge runs cannot change the verdict", async (forgery) => {
    const { repo, head } = fixPr();
    forgeries[forgery]!(repo, head);
    const failed = report({ "src/math.test.ts": "failed" });
    const reports = { base: failed, baseRerun: failed, head: report({ "src/math.test.ts": "passed" }) };

    const result = parsed(await judge({ repo: repo.dir, base: repo.base, head, reports }));

    expect(result).toMatchObject({ verdict: "reproduced", head });
  });

  it("every git call the judge makes ignores replace refs and pathspec magic", async () => {
    const calls: (readonly string[])[] = [];
    const exec: Exec = (file, args, options) => {
      calls.push(args);
      return spawnExec(file, args, options);
    };
    const failed = report({ "src/math.test.ts": "failed" });

    await verdictFor({ base: failed, baseRerun: failed, head: report({ "src/math.test.ts": "passed" }) }, exec);

    expect(calls.length).toBeGreaterThan(0);
    calls.forEach((args) => expect(args.slice(0, GIT_SAFETY.length)).toEqual([...GIT_SAFETY]));
  });

  it("prints a no-tests line without reading any report", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED });

    expect(parsed(await judge({ repo: repo.dir, base: repo.base, head, reports: {} })).verdict).toBe("no-tests");
  });
});

describe("judge with mutation specs", () => {
  const SPEC = "src/math.test.mutations.json";
  const mutation = { name: "zero", file: "src/math.ts", find: "a - b", replace: "a - b + 1", kills: ["adds zero"] };
  const specText = (find = mutation.find) => JSON.stringify({ v: 1, mutations: [{ ...mutation, find }] });

  function zeroReport(status: "passed" | "failed"): unknown {
    const failureMessages = status === "failed" ? ["expected 1 to be 0"] : [];
    return { testResults: [{ name: "src/math.test.ts", status, assertionResults: [{ fullName: "adds zero", status, failureMessages }] }] };
  }

  const reports = (mutants?: string): JudgeReports => {
    const passed = encodeReport(zeroReport("passed"));
    return { base: passed, baseRerun: passed, head: passed, ...(mutants === undefined ? {} : { mutants }) };
  };
  const killedMutants = encodeMutantsReport({
    baseline: zeroReport("passed"),
    runs: [{ spec: SPEC, name: "zero", built: true, report: zeroReport("failed") }],
  });

  async function judgeHead(files: Record<string, string>, mutants?: string) {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.test.ts": VACUOUS_TEST, ...files });
    return parsed(await judge({ repo: repo.dir, base: repo.base, head, reports: reports(mutants) }));
  }

  it("attaches killed mutants to a vacuous tests-only diff", async () => {
    const result = await judgeHead({ [SPEC]: specText(), ".changeset/x.md": "---\n---\n" }, killedMutants);

    expect(result.verdict).toBe("vacuous");
    expect(result.mutants).toEqual({ verdict: "killed", results: [{ spec: SPEC, name: "zero", outcome: "killed" }] });
  });

  it("attaches no mutants when the diff also changes source", async () => {
    const result = await judgeHead({ [SPEC]: specText(), "src/math.ts": "export const add = (a: number, b: number) => a - b;\n// touched\n" }, killedMutants);

    expect(result.mutants).toBeUndefined();
  });

  it("attaches no mutants when the diff has no spec", async () => {
    expect((await judgeHead({}, killedMutants)).mutants).toBeUndefined();
  });

  it("a spec whose find does not occur once at the merge base is a mutants error, not a killed verdict", async () => {
    const result = await judgeHead({ [SPEC]: specText("a * b") }, killedMutants);

    expect(result.verdict).toBe("vacuous");
    expect(result.mutants).toMatchObject({ verdict: "error", error: expect.stringContaining("does not occur") });
  });

  it("a spec with no test beside it is a mutants error", async () => {
    const result = await judgeHead({ "src/lonely.test.mutations.json": specText() }, killedMutants);

    expect(result.mutants).toMatchObject({ verdict: "error", error: expect.stringContaining("no single test file") });
  });

  it("a missing mutants report is a mutants error and leaves the base-vs-head verdict alone", async () => {
    const result = await judgeHead({ [SPEC]: specText() });

    expect(result.verdict).toBe("vacuous");
    expect(result.mutants).toMatchObject({ verdict: "error", error: "mutants: missing report" });
  });
});
