import { afterEach, describe, expect, it } from "vitest";
import { spawnExec, type Exec } from "./exec.js";
import { judge, type JudgeReports } from "./judge.js";
import { FIXED, makeRepo, parsed, REAL_TEST, removeRepos, type Repo } from "./repo.test-helpers.js";
import { encodeError, encodeReport } from "./transport.js";

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

  it("prints a no-tests line without reading any report", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED });

    expect(parsed(await judge({ repo: repo.dir, base: repo.base, head, reports: {} })).verdict).toBe("no-tests");
  });
});
