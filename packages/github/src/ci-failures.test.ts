import { describe, expect, it } from "vitest";
import { ciFailures, digestJobLog, formatCiFailures } from "./ci-failures.js";
import { fakeGitHub, fakeSha, successRun } from "./fake.js";
import { githubPort } from "./port.js";

const ESC = "\u001b";
const stamp = (line: string): string => `2026-10-11T12:00:00.1234567Z ${line}`;

const FAILING_TEST_LOG = [
  "﻿" + stamp("> vitest run"),
  stamp(`${ESC}[31m FAIL ${ESC}[39m src/widget.test.ts > widget > renders`),
  stamp(`${ESC}[31m × ${ESC}[39mrenders 4ms`),
  stamp(`AssertionError: expected 1 to be 2`),
  stamp(` ${ESC}[2mTest Files${ESC}[22m  ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m | 3 passed (4)`),
  stamp(`      ${ESC}[2mTests${ESC}[22m  ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m | 20 passed (21)`),
  stamp("##[error]Process completed with exit code 1."),
  "",
].join("\n");

const COVERAGE_LOG = [
  stamp(" Test Files  4 passed (4)"),
  stamp("      Tests  21 passed (21)"),
  stamp("ERROR: Coverage for lines (78.2%) does not meet global threshold (80%)"),
  stamp("##[error]Process completed with exit code 1."),
].join("\n");

const OBSOLETE_LOG = [stamp("   Snapshots  1 obsolete"), stamp("              ↳ src/widget.test.ts"), stamp("##[error]Process completed with exit code 1.")].join("\n");

const UNRECOGNISED_LOG = Array.from({ length: 30 }, (_, i) => stamp(`step ${i + 1}`)).join("\n");

describe("digestJobLog", () => {
  it("picks the first failing test and the summary from a coloured vitest log, stripping ANSI and timestamps", () => {
    const digest = digestJobLog(FAILING_TEST_LOG);

    expect(digest).toMatchObject({
      firstFailure: "FAIL  src/widget.test.ts > widget > renders",
      summary: ["Test Files  1 failed | 3 passed (4)", "Tests  1 failed | 20 passed (21)"],
      coverage: [],
      recognised: true,
    });
    expect(digest.tail.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(digest.tail.join("\n")).not.toContain(ESC);
    expect(digest.tail.join("\n")).not.toContain("2026-10-11T");
  });

  it("reports a coverage-threshold miss when every test passed", () => {
    const digest = digestJobLog(COVERAGE_LOG);

    expect(digest).toMatchObject({ firstFailure: null, coverage: ["ERROR: Coverage for lines (78.2%) does not meet global threshold (80%)"], recognised: true });
  });

  it("reports an obsolete snapshot line", () => {
    expect(digestJobLog(OBSOLETE_LOG)).toMatchObject({ obsoleteSnapshots: ["Snapshots  1 obsolete"], recognised: true });
  });

  it("falls back to the tail alone, marked unrecognised, when no line matches", () => {
    const digest = digestJobLog(UNRECOGNISED_LOG, 5);

    expect(digest).toMatchObject({ firstFailure: null, summary: [], coverage: [], obsoleteSnapshots: [], recognised: false });
    expect(digest.tail).toEqual(["step 26", "step 27", "step 28", "step 29", "step 30"]);
  });
});

function setup() {
  const fake = fakeGitHub();
  const head = fakeSha("head");
  fake.addPr({ headSha: head });
  return { fake, head, port: githubPort(fake.wire) };
}

describe("ciFailures", () => {
  it("digests each failing Actions job at the PR head and skips the passing one", async () => {
    const { fake, head, port } = setup();
    fake.setRuns(head, [successRun("unit", 11, undefined, "failure"), successRun("lint", 12), successRun("coverage", 13, undefined, "failure")]);
    fake.jobLogs.set(11, FAILING_TEST_LOG);
    fake.jobLogs.set(13, COVERAGE_LOG);

    const result = await ciFailures(port, { repo: "o/r", number: 1 });

    expect(result.jobs.map((job) => [job.job, job.url])).toEqual([
      ["unit", "https://example.test/actions/runs/1011/job/11"],
      ["coverage", "https://example.test/actions/runs/1013/job/13"],
    ]);
    expect(result.skipped).toEqual([]);
    const text = formatCiFailures(result);
    expect(text).toContain("FAILED unit https://example.test/actions/runs/1011/job/11\nfirst failure: FAIL  src/widget.test.ts > widget > renders");
    expect(text).toContain("FAILED coverage https://example.test/actions/runs/1013/job/13\nTest Files  4 passed (4)\nTests  21 passed (21)\nERROR: Coverage");
    expect(text).not.toContain("lint");
  });

  it("reads at most five failing jobs and names the rest as skipped", async () => {
    const { fake, head, port } = setup();
    fake.setRuns(head, Array.from({ length: 7 }, (_, i) => successRun(`job${i + 1}`, i + 1, undefined, "failure")));
    for (let id = 1; id <= 7; id++) fake.jobLogs.set(id, UNRECOGNISED_LOG);

    const result = await ciFailures(port, { repo: "o/r", number: 1 });

    expect(result.jobs).toHaveLength(5);
    expect(result.skipped).toEqual(["job6", "job7"]);
    expect(formatCiFailures(result)).toContain("skipped 2 more failing job(s): job6, job7");
  });

  it("says there is no failing Actions job at the head", async () => {
    const { fake, head, port } = setup();
    fake.setRuns(head, [successRun("unit", 11)]);

    expect(formatCiFailures(await ciFailures(port, { repo: "o/r", number: 1 }))).toBe(`no failing Actions job at ${head.slice(0, 7)}`);
  });
});
