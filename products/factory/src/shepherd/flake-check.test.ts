import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { H1, REPO } from "../test-support/land.js";
import { failuresOutsideDiff } from "./flake-check.js";

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

const failed = (file: string) => [
  "⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯",
  `FAIL  ${file} > bounded`,
  "AssertionError: expected 1 to be 2",
  "⎯⎯⎯⎯⎯⎯⎯[1/1]⎯⎯⎯⎯⎯⎯⎯",
  "      Tests  1 failed | 10 passed (11)",
];
const vitestLog = (file: string) => failed(file).join("\n");

describe("failuresOutsideDiff", () => {
  it("qualifies a failing test file the PR did not change", async () => {
    const port = scene(vitestLog("packages/decider/src/ask-lint.test.ts"), ["products/factory/src/a.ts"]);

    expect(await failuresOutsideDiff(port, input)).toMatchObject({ outside: true });
  });

  it("does not qualify a failing test file the PR changed", async () => {
    const port = scene(vitestLog("packages/decider/src/ask-lint.test.ts"), ["packages/decider/src/ask-lint.test.ts"]);

    expect(await failuresOutsideDiff(port, input)).toMatchObject({ outside: false });
  });

  it("does not qualify a failure that names no test file", async () => {
    const port = scene("error TS2322: type mismatch", ["a.ts"]);

    expect(await failuresOutsideDiff(port, input)).toMatchObject({ outside: false, detail: "a failing job names no failing test file" });
  });

  it("does not qualify a log with an Unhandled Errors banner, whose crashed worker may be the real failure", async () => {
    const log = [...failed("packages/decider/src/ask-lint.test.ts"), "⎯⎯ Unhandled Errors ⎯⎯", "Vitest caught 1 unhandled error"].join("\n");

    expect(await failuresOutsideDiff(scene(log, ["a.ts"]), input)).toMatchObject({ outside: false });
  });

  it("does not qualify a tail cut before the Failed Tests banner", async () => {
    const log = ["FAIL  packages/decider/src/ask-lint.test.ts > bounded", "⎯⎯⎯⎯⎯⎯⎯[1/1]⎯⎯⎯⎯⎯⎯⎯", "      Tests  1 failed | 10 passed (11)"].join("\n");

    expect(await failuresOutsideDiff(scene(log, ["a.ts"]), input)).toMatchObject({ outside: false });
  });

  it("does not qualify a FAIL line printed by console output above the banner", async () => {
    const log = ["stdout | x.test.ts", " FAIL  d/ghost.test.ts > not a failure", "⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯", "FAIL  packages/decider/src/ask-lint.test.ts > bounded", "⎯⎯⎯⎯⎯⎯⎯[1/1]⎯⎯⎯⎯⎯⎯⎯", "      Tests  1 failed | 10 passed (11)"].join("\n");

    expect(await failuresOutsideDiff(scene(log, ["packages/decider/src/ask-lint.test.ts"]), input)).toMatchObject({ outside: false });
  });

  it("does not qualify a changeset-only red", async () => {
    const log = "##[error]A changeset is required for packages/github\n##[error]Process completed with exit code 1.";

    expect(await failuresOutsideDiff(scene(log, ["a.ts"]), input)).toMatchObject({ outside: false, detail: "a failing job names no failing test file" });
  });
});
