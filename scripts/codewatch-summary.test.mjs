import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { renderSummary, summarizeFile } from "./codewatch-summary.mjs";

const fixturePath = (name) => new URL(`../.codewatch/fixtures/${name}`, import.meta.url);
const readFixture = (name) => JSON.parse(readFileSync(fixturePath(name), "utf8"));
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "codewatch-summary-"));
  roots.push(root);
  return root;
}

describe("renderSummary", () => {
  it("summarizes the clean fixture as passed with no questions", () => {
    const summary = renderSummary(readFixture("pr-report-clean.json"));

    expect(summary).toContain("Check passed: 0 new error(s), 0 new warning(s), 1 carryover.");
    expect(summary).toContain("Head `111111111111` against base `000000000000`.");
    expect(summary).not.toContain("### Questions");
  });

  it("summarizes the worsened fixture as failed with its counts and three questions", () => {
    const fixture = readFixture("pr-report-worsened.json");

    const summary = renderSummary(fixture);

    expect(summary).toContain("Check failed: 1 new error(s), 0 new warning(s), 0 carryover.");
    expect(summary).toContain("3 metric delta(s), 1 export change(s).");
    expect(summary).toContain(fixture.questions.map((q) => `- ${q}`).join("\n"));
  });

  it("renders the questions the report carries instead of re-deriving them", () => {
    const questions = ["a/b.ts:3 carries a question the rules would not derive", "c/d.ts:1 carries another"];

    const summary = renderSummary({ ...readFixture("pr-report-worsened.json"), questions });

    expect(summary).toContain("### Questions\n\n- a/b.ts:3 carries a question the rules would not derive\n- c/d.ts:1 carries another\n");
  });

  it("says when the report has no baseline", () => {
    const summary = renderSummary({ ...readFixture("pr-report-clean.json"), base: null });

    expect(summary).toContain("against base `none`");
  });
});

describe("summarizeFile", () => {
  it("renders a report read from disk", () => {
    expect(summarizeFile(fixturePath("pr-report-worsened.json").pathname)).toContain("Check failed");
  });

  it("notes a missing report instead of throwing", () => {
    expect(summarizeFile(join(tempDir(), "absent.json"))).toContain("No report was written");
  });

  it("notes an unreadable report instead of throwing", () => {
    const file = join(tempDir(), "broken.json");
    writeFileSync(file, "{not json");

    expect(summarizeFile(file)).toContain("The report could not be read");
  });
});

describe("summary CLI", () => {
  it("exits 0 on a report with failing rules", () => {
    const script = fileURLToPath(new URL("./codewatch-summary.mjs", import.meta.url));

    const run = spawnSync(process.execPath, [script, fileURLToPath(fixturePath("pr-report-worsened.json"))], { encoding: "utf8" });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Check failed");
  });
});
