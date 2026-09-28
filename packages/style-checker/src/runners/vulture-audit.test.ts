import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBin } from "../test-support/fake-bin.js";
import type { FakeBin } from "../test-support/fake-bin.js";
import { PROJECT, captured, replay, seenArgs } from "../test-support/python-audit.js";
import { runVultureAudit } from "./vulture-audit.js";

const vultureRun = { stdout: captured("vulture.stdout.txt"), stderr: captured("vulture.stderr.txt"), exitCode: 3 };

describe("runVultureAudit", () => {
  let bin: FakeBin;

  beforeEach(() => {
    bin = createFakeBin();
  });
  afterEach(() => bin.restore());

  it("reports each finding under a rule named by vulture's kind, at the default 60% confidence", async () => {
    replay(bin, "vulture", vultureRun);

    const result = await runVultureAudit(["pkg", "broken.py"], { cwd: PROJECT });

    expect(seenArgs(bin)).toEqual(["--min-confidence", "60", "pkg", "broken.py"]);
    expect(result.diagnostics.map((d) => `${d.rule}@${d.line}`)).toEqual([
      "vulture/unused-import@1",
      "vulture/unused-function@7",
      "vulture/unused-function@23",
      "vulture/unused-variable@31",
      "vulture/unreachable@33",
      "vulture/unused-class@36",
      "vulture/unused-variable@37",
      "vulture/unused-function@40",
      "vulture/unused-class@56",
      "vulture/unused-attribute@58",
      "vulture/unused-method@60",
      "vulture/unused-property@63",
    ]);
    expect(result.diagnostics[0]).toMatchObject({ file: "pkg/core.py", message: "unused import 'os' (90% confidence)" });
    expect(result.warnings).toEqual([]);
  });

  it("reports a file vulture could not parse as not checked, beside the other findings", async () => {
    replay(bin, "vulture", vultureRun);

    const result = await runVultureAudit(["pkg", "broken.py"], { cwd: PROJECT });

    expect(result.failures).toEqual([
      { tool: "vulture", kind: "file-not-checked", file: "broken.py", message: 'invalid syntax at "def broken(:"' },
    ]);
  });

  it("passes an overridden confidence floor", async () => {
    replay(bin, "vulture", { exitCode: 0 });

    const result = await runVultureAudit(["pkg"], { cwd: PROJECT, minConfidence: 100 });

    expect(seenArgs(bin).slice(0, 2)).toEqual(["--min-confidence", "100"]);
    expect(result).toMatchObject({ diagnostics: [], failures: [], exitCode: 0 });
  });

  it("warns with the install command instead of throwing when vulture is not installed", async () => {
    bin.onPathOnly();

    const result = await runVultureAudit(["pkg"], { cwd: PROJECT });

    expect(result).toMatchObject({ diagnostics: [], failures: [], exitCode: null });
    expect(result.warnings).toEqual(["vulture not found; install with `pip install vulture`"]);
  });

  it("treats a shell's 'command not found' exit as an absent tool", async () => {
    replay(bin, "vulture", { stderr: "sh: vulture: command not found", exitCode: 127 });

    const result = await runVultureAudit(["pkg"], { cwd: PROJECT });

    expect(result.warnings).toEqual(["vulture not found; install with `pip install vulture`"]);
  });

  it("reports output it cannot read as a failure rather than dropping it", async () => {
    replay(bin, "vulture", { stdout: "Traceback (most recent call last):", exitCode: 1 });

    const result = await runVultureAudit(["pkg"], { cwd: PROJECT });

    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([expect.objectContaining({ tool: "vulture", kind: "unparseable-output" })]);
  });
});
