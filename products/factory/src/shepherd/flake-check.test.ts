import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { H1, REPO } from "../test-support/land.js";
import { failingTestFiles, failuresOutsideDiff } from "./flake-check.js";

function scene(log: string, changed: string[]) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.setRuns(H1, [successRun("validate", 7, undefined, "failure")]);
  fake.jobLogs.set(7, log);
  fake.prFiles.set(1, changed.map((path) => ({ path, status: "modified" })));
  fake.prChangedFiles.set(1, changed.length);
  return githubPort(fake.wire);
}

const input = { repo: REPO, pr: 1, headSha: H1, failing: [{ name: "validate" }] };

describe("failingTestFiles", () => {
  it("reads the file of each vitest FAIL line once", () => {
    const log = " FAIL  a/x.test.ts > one\n FAIL  a/x.test.ts > two\n FAIL  |unit| b/y.spec.tsx > three\nPASS c/z.test.ts";

    expect(failingTestFiles(log)).toEqual(["a/x.test.ts", "b/y.spec.tsx"]);
  });
});

describe("failuresOutsideDiff", () => {
  it("qualifies a failing test file the PR did not change", async () => {
    const port = scene(" FAIL  packages/decider/src/ask-lint.test.ts > bounded", ["products/factory/src/a.ts"]);

    expect(await failuresOutsideDiff(port, input)).toMatchObject({ outside: true });
  });

  it("does not qualify a failing test file the PR changed", async () => {
    const port = scene(" FAIL  packages/decider/src/ask-lint.test.ts > bounded", ["packages/decider/src/ask-lint.test.ts"]);

    expect(await failuresOutsideDiff(port, input)).toMatchObject({ outside: false });
  });

  it("does not qualify a failure that names no test file", async () => {
    const port = scene("error TS2322: type mismatch", ["a.ts"]);

    expect(await failuresOutsideDiff(port, input)).toMatchObject({ outside: false, detail: "a failing job names no failing test file" });
  });
});
