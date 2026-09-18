import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runRuff } from "./ruff-runner.js";
import { createFakeBin, heredoc } from "../test-support/fake-bin.js";
import type { FakeBin } from "../test-support/fake-bin.js";
import type { RuffConfig } from "../generators/ruff.js";

// Written to ruff's documented `--output-format json` shape; ruff is not installed here to capture it.
const findings = [
  {
    cell: null, code: "N806", filename: "/p/app.py", fix: null, noqa_row: 5,
    location: { row: 5, column: 5 }, end_location: { row: 5, column: 11 },
    message: "Variable `userId` in function should be lowercase",
    url: "https://docs.astral.sh/ruff/rules/non-lowercase-variable-in-function",
  },
];
const syntaxError = {
  cell: null, code: null, filename: "/p/broken.py", fix: null, noqa_row: null,
  location: { row: 1, column: 9 }, end_location: { row: 1, column: 10 },
  message: "SyntaxError: Expected an expression", url: null,
};

const config: RuffConfig = { lint: { select: ["N"] } };

describe("runRuff", () => {
  let bin: FakeBin;

  beforeEach(() => {
    bin = createFakeBin();
  });
  afterEach(() => bin.restore());

  it("treats exit 1 with findings as a successful run and passes the generated config", async () => {
    bin.install("ruff", `cp "$3" "${bin.dir}/seen.toml"\n${heredoc(JSON.stringify(findings))}\nexit 1`);
    bin.onPathFirst();

    const result = await runRuff(config, ["app.py"]);

    expect(result.failures).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ file: "/p/app.py", line: 5, rule: "N806", category: "naming" })]);
    expect(readFileSync(join(bin.dir, "seen.toml"), "utf-8")).toBe('[lint]\nselect = ["N"]\n');
  });

  it("returns no diagnostics and no failures for a clean run", async () => {
    bin.install("ruff", `${heredoc("[]")}\nexit 0`);
    bin.onPathFirst();

    const result = await runRuff(config, ["app.py"]);

    expect(result).toMatchObject({ diagnostics: [], failures: [], exitCode: 0 });
  });

  it("reports a file ruff could not parse as a failure beside the other findings", async () => {
    bin.install("ruff", `${heredoc(JSON.stringify([...findings, syntaxError]))}\nexit 1`);
    bin.onPathFirst();

    const result = await runRuff(config, ["app.py", "broken.py"]);

    expect(result.diagnostics.map((d) => d.rule)).toEqual(["N806"]);
    expect(result.failures).toEqual([
      { tool: "ruff", kind: "file-not-checked", file: "/p/broken.py", message: "SyntaxError: Expected an expression" },
    ]);
  });

  it("reports an invalid configuration (exit 2) as an exit-code failure with ruff's message", async () => {
    bin.install("ruff", `${heredoc("ruff failed\n  Cause: unknown field `selct`", "stderr")}\nexit 2`);
    bin.onPathFirst();

    const result = await runRuff(config, ["app.py"]);

    expect(result.failures).toEqual([expect.objectContaining({ tool: "ruff", kind: "exit-code" })]);
    expect(result.failures[0]!.message).toMatch(/exited with code 2: ruff failed/);
  });

  it("reports output that is not JSON as unparseable", async () => {
    bin.install("ruff", `${heredoc("warning: something")}\nexit 0`);
    bin.onPathFirst();

    const result = await runRuff(config, ["app.py"]);

    expect(result.failures).toEqual([expect.objectContaining({ kind: "unparseable-output" })]);
  });

  it("reports a child killed by a signal", async () => {
    bin.install("ruff", "kill -TERM $$");
    bin.onPathFirst();

    const result = await runRuff(config, ["app.py"]);

    expect(result.failures).toEqual([expect.objectContaining({ kind: "signal" })]);
    expect(result.failures[0]!.message).toMatch(/SIGTERM/);
  });

  it("reports a missing ruff as a spawn failure instead of throwing", async () => {
    bin.onPathOnly();

    const result = await runRuff(config, ["app.py"]);

    expect(result.failures).toEqual([expect.objectContaining({ tool: "ruff", kind: "spawn-failed" })]);
  });
});
