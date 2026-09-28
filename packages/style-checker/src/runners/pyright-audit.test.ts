import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBin } from "../test-support/fake-bin.js";
import type { FakeBin } from "../test-support/fake-bin.js";
import { PROJECT, captured, replay, seenArgs } from "../test-support/python-audit.js";
import { runPyrightAudit } from "./pyright-audit.js";

// The capture rewrote the fixture project's absolute path to /project.
const pyrightRun = { stdout: captured("pyright.stdout.json").replaceAll("/project", PROJECT), exitCode: 1 };
const keepConfig = `cp "$3" "$(dirname "$0")/seen.json"`;

function missingImport(file: string): object {
  const range = { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } };
  return { file, severity: "warning", message: 'Import "pkg" could not be resolved', range, rule: "reportMissingImports" };
}

describe("runPyrightAudit", () => {
  let bin: FakeBin;

  beforeEach(() => {
    bin = createFakeBin();
  });
  afterEach(() => bin.restore());

  it("reports the four unnecessary-* rules with 1-based lines and repo-relative files", async () => {
    replay(bin, "pyright", { ...pyrightRun, before: keepConfig });

    const result = await runPyrightAudit(["pkg", "broken.py"], { cwd: PROJECT });

    expect(result.diagnostics.map((d) => `${d.file}:${d.line}:${d.column} ${d.rule}`)).toEqual([
      "pkg/core.py:41:8 pyright/reportUnnecessaryIsInstance",
      "pkg/core.py:43:8 pyright/reportUnnecessaryComparison",
      "pkg/core.py:45:9 pyright/reportUnnecessaryCast",
      "pkg/core.py:46:27 pyright/reportUnnecessaryContains",
    ]);
    expect(result.diagnostics[0]).toMatchObject({ endLine: 41, severity: "warn" });
  });

  it("passes a config with only the audit rules on, and the project root on extraPaths", async () => {
    replay(bin, "pyright", { ...pyrightRun, before: keepConfig });

    await runPyrightAudit(["pkg"], { cwd: PROJECT, pythonPath: "/usr/bin/python3" });

    const args = seenArgs(bin);
    expect([args[0], args[1], ...args.slice(3)]).toEqual(["--outputjson", "-p", "--pythonpath", "/usr/bin/python3", "pkg"]);
    expect(JSON.parse(readFileSync(join(bin.dir, "seen.json"), "utf-8"))).toEqual({
      typeCheckingMode: "off",
      extraPaths: [PROJECT],
      reportMissingImports: "none",
      reportMissingModuleSource: "none",
      reportUndefinedVariable: "none",
      reportUnnecessaryIsInstance: "warning",
      reportUnnecessaryComparison: "warning",
      reportUnnecessaryContains: "warning",
      reportUnnecessaryCast: "warning",
    });
  });

  it("reports a file with syntax errors once, as not checked", async () => {
    replay(bin, "pyright", pyrightRun);

    const result = await runPyrightAudit(["pkg", "broken.py"], { cwd: PROJECT });

    expect(result.failures).toEqual([expect.objectContaining({ tool: "pyright", kind: "file-not-checked", file: "broken.py" })]);
    expect(result.failures[0]!.message.split("; ")).toHaveLength(7);
  });

  it("drops diagnostics from rules outside the audit set", async () => {
    const stdout = JSON.stringify({ generalDiagnostics: [missingImport(join(PROJECT, "pkg/helpers.py"))] });
    replay(bin, "pyright", { stdout, exitCode: 0 });

    const result = await runPyrightAudit(["pkg"], { cwd: PROJECT });

    expect(result).toMatchObject({ diagnostics: [], failures: [] });
  });

  it("warns with the install command and the Node requirement when pyright is not installed", async () => {
    bin.onPathOnly();

    const result = await runPyrightAudit(["pkg"], { cwd: PROJECT });

    expect(result.diagnostics).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/^pyright not found; install with `pip install pyright` \(.*Node on PATH/)]);
  });

  it("reports non-JSON output as unreadable", async () => {
    replay(bin, "pyright", { stdout: "No configuration file found.", exitCode: 1 });

    const result = await runPyrightAudit(["pkg"], { cwd: PROJECT });

    expect(result.failures).toEqual([expect.objectContaining({ tool: "pyright", kind: "unparseable-output" })]);
  });
});
