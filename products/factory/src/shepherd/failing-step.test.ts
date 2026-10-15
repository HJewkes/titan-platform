import { describe, expect, it } from "vitest";
import { failureIds } from "./failing-step.js";

const STAMP = "2026-10-13T12:00:00.0000000Z ";
const log = (...lines: string[]) => lines.map((line) => `${STAMP}${line}`).join("\n");
const ESC = "\u001b";
const red = (text: string) => `${ESC}[41m${ESC}[1m${text}${ESC}[22m${ESC}[49m`;

const A = "a/x.test.ts > suite > one";
const B = "b/y.spec.tsx > two";
const SUITE = "c/z.test.ts [ c/z.test.ts ]";

/** One failure as vitest prints it: the heading, its error, and the divider numbered across both sections. */
const failure = (id: string, n: number, total: number) => [` FAIL  ${id}`, "AssertionError: expected 1 to be 2", `⎯⎯⎯⎯[${n}/${total}]⎯`];
const summary = (failed: number) => [" Test Files  2 failed | 8 passed (10)", `      Tests  ${failed} failed | 9 passed (${failed + 9})`];

/** A whole vitest failure output with one failed suite and two failed tests. */
const SUITE_AND_TESTS = [" RUN  v4.1.11", "⎯⎯ Failed Suites 1 ⎯⎯", ...failure(SUITE, 1, 3), "⎯⎯ Failed Tests 2 ⎯⎯", ...failure(A, 2, 3), ...failure(B, 3, 3), ...summary(2)];

describe("failureIds", () => {
  it("names each failing vitest test once, project label and colour dropped, between the banner and the summary", () => {
    const heading = `${red(" FAIL ")} ${ESC}[30m${ESC}[46m threads ${ESC}[49m${ESC}[39m ${A}`;
    const tail = log("⎯⎯ Failed Tests 2 ⎯⎯", heading, "AssertionError", "⎯⎯[1/3]⎯", ` FAIL  |forks| ${B}`, ` FAIL  ${B}`, "AssertionError", "⎯⎯[2/3]⎯", ...summary(2));

    expect(failureIds(tail)).toEqual([A, B]);
  });

  it("names a failed suite with the failed tests after it", () => {
    expect(failureIds(log(...SUITE_AND_TESTS))).toEqual([SUITE, A, B]);
  });

  it("names a suite that failed to load when the summary counts no tests at all", () => {
    expect(failureIds(log("⎯⎯ Failed Suites 1 ⎯⎯", ...failure(SUITE, 1, 1), " Test Files  1 failed (1)", "      Tests  no tests"))).toEqual([SUITE]);
  });

  it("names nothing when the tail holds failure headings but not the banner over them, since earlier ones may be cut", () => {
    expect(failureIds(log(...failure(A, 1, 1), ...summary(1)))).toBeUndefined();
  });

  // Mutation caught: dropping the unhandled-error check, which leaves the same ids as a base without the crash.
  it.each([
    ["the Unhandled Errors banner", "⎯⎯ Unhandled Errors ⎯⎯"],
    ["the Errors summary line", "     Errors  1 error"],
  ])("names nothing when a worker crash shows by %s, since that failure has no heading", (_, crash) => {
    const lines = [...SUITE_AND_TESTS];
    lines.splice(-1, 0, crash);

    expect(failureIds(log(...lines))).toBeUndefined();
  });

  // Mutation caught: dropping the first-divider check, after which the Failed Tests headings match the summary's 2.
  it("names nothing when the tail is cut inside Failed Suites, leaving its first divider above the Failed Tests banner", () => {
    expect(failureIds(log(...SUITE_AND_TESTS.slice(2)))).toBeUndefined();
  });

  // Mutation caught: dropping the first-divider check, after which the two remaining headings match the summary's 2.
  it("names nothing when the tail starts at the Failed Tests banner, cutting the whole Failed Suites section", () => {
    expect(failureIds(log(...SUITE_AND_TESTS.slice(5)))).toBeUndefined();
  });

  // Mutation caught: dropping the count check, after which the one heading left is held as the whole failure.
  it("names nothing when the headings number fewer than the summary's failed tests and the banner's failed suites", () => {
    expect(failureIds(log("⎯⎯ Failed Tests 2 ⎯⎯", ...failure(A, 1, 2), ...summary(2)))).toBeUndefined();
  });

  // Mutation caught: reading headings from the whole log rather than the failure output.
  it("does not take a FAIL heading printed by console output above the failure output as a failure id", () => {
    expect(failureIds(log("stdout | a/x.test.ts > suite > one", " FAIL  d/ghost.test.ts > not a vitest heading", ...SUITE_AND_TESTS))).toEqual([SUITE, A, B]);
  });

  // Mutation caught: dropping the line-start anchor on headings, which counts the quoted heading and misses the summary.
  it("does not take a FAIL heading quoted inside an error message as a failure id", () => {
    const lines = [...SUITE_AND_TESTS];
    lines.splice(4, 0, `Error: expected log to contain " FAIL  d/ghost.test.ts > quoted"`);

    expect(failureIds(log(...lines))).toEqual([SUITE, A, B]);
  });

  it("takes a log with no vitest heading by its error lines, leaving out the runner's exit code", () => {
    const tail = log("##[error]A changeset is required for packages/github", "##[error]Process completed with exit code 1.");

    expect(failureIds(tail)).toEqual(["A changeset is required for packages/github"]);
  });

  it("names nothing when the only error is the runner's exit code", () => {
    expect(failureIds(log("some output", "##[error]Process completed with exit code 1."))).toBeUndefined();
  });

  // Mutation caught: dropping the stopped-step check, which takes the runner's generic stop message as the failure.
  it.each([
    ["timed out", "##[error]The job running on runner GitHub Actions 2 has exceeded the maximum execution time of 30 minutes."],
    ["cancelled", "##[error]The operation was canceled."],
  ])("names nothing for a step the runner %s", (_, stopped) => {
    expect(failureIds(log("building", stopped, "##[error]Process completed with exit code 1."))).toBeUndefined();
  });
});
