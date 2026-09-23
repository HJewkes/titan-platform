import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBin } from "../test-support/fake-bin.js";
import type { FakeBin } from "../test-support/fake-bin.js";
import { PROJECT, captured, replay, seenArgs } from "../test-support/python-audit.js";
import { runPydoclintAudit } from "./pydoclint-audit.js";

describe("runPydoclintAudit", () => {
  let bin: FakeBin;

  beforeEach(() => {
    bin = createFakeBin();
  });
  afterEach(() => bin.restore());

  it("reads the violations pydoclint prints on stderr, under pydoclint/DOCnnn rules", async () => {
    replay(bin, "pydoclint", { stderr: captured("pydoclint.stderr.txt"), exitCode: 1 });

    const result = await runPydoclintAudit(["pkg", "broken.py"], { cwd: PROJECT });

    expect(seenArgs(bin)).toEqual(["--style", "numpy", "--quiet", "pkg", "broken.py"]);
    expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.rule}`)).toEqual([
      "pkg/core.py:23 pydoclint/DOC106",
      "pkg/core.py:23 pydoclint/DOC107",
      "pkg/core.py:23 pydoclint/DOC103",
      "pkg/core.py:23 pydoclint/DOC201",
    ]);
    expect(result.diagnostics[3]!.message).toBe("Function `unused_function` does not have a return section in docstring");
  });

  it("reports a file pydoclint could not parse as not checked instead of as a DOC002 finding", async () => {
    replay(bin, "pydoclint", { stderr: captured("pydoclint.stderr.txt"), exitCode: 1 });

    const result = await runPydoclintAudit(["pkg", "broken.py"], { cwd: PROJECT });

    expect(result.failures).toEqual([
      expect.objectContaining({ tool: "pydoclint", kind: "file-not-checked", file: "broken.py" }),
    ]);
  });

  it("returns nothing for a clean run, which prints nothing at all", async () => {
    replay(bin, "pydoclint", { exitCode: 0 });

    const result = await runPydoclintAudit(["pkg/helpers.py"], { cwd: PROJECT, style: "google" });

    expect(seenArgs(bin).slice(0, 2)).toEqual(["--style", "google"]);
    expect(result).toMatchObject({ diagnostics: [], failures: [], warnings: [], exitCode: 0 });
  });

  it("warns with the install command instead of throwing when pydoclint is not installed", async () => {
    bin.onPathOnly();

    const result = await runPydoclintAudit(["pkg"], { cwd: PROJECT });

    expect(result).toMatchObject({ diagnostics: [], failures: [] });
    expect(result.warnings).toEqual(["pydoclint not found; install with `pip install pydoclint`"]);
  });

  it("reports a usage error as a failed run", async () => {
    replay(bin, "pydoclint", { stderr: "Error: Invalid value for '[PATHS]...': Path 'nope.py' does not exist.", exitCode: 2 });

    const result = await runPydoclintAudit(["nope.py"], { cwd: PROJECT });

    expect(result.failures).toEqual([expect.objectContaining({ tool: "pydoclint", kind: "exit-code" })]);
  });

  it("reports a traceback as unreadable output rather than as findings", async () => {
    replay(bin, "pydoclint", { stderr: 'Traceback (most recent call last):\n  File "x.py", line 1', exitCode: 1 });

    const result = await runPydoclintAudit(["pkg"], { cwd: PROJECT });

    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([expect.objectContaining({ tool: "pydoclint", kind: "unparseable-output" })]);
  });
});
