import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRuff } from "./ruff-runner.js";
import { createFakeBin, heredoc } from "../test-support/fake-bin.js";
import type { FakeBin } from "../test-support/fake-bin.js";
import type { RuffConfig } from "../generators/ruff.js";

// Output captured from real ruff; see fixtures/ruff/README.md for versions and commands.
const captured = fileURLToPath(new URL("../../fixtures/ruff", import.meta.url));

function replay(name: string, exitCode: number): string {
  const lines = [`cp "$3" "$(dirname "$0")/seen.toml"`];
  const stdout = join(captured, `${name}.stdout.json`);
  const stderr = join(captured, `${name}.stderr.txt`);
  if (existsSync(stdout)) lines.push(`cat "${stdout}"`);
  if (existsSync(stderr)) lines.push(`cat "${stderr}" >&2`);
  return [...lines, `exit ${exitCode}`].join("\n");
}

const naming = { file: "/project/findings.py", line: 2, column: 5, severity: "warn", category: "naming", rule: "N806" };
const config: RuffConfig = { lint: { select: ["N"] } };

describe("runRuff", () => {
  let bin: FakeBin;

  beforeEach(() => {
    bin = createFakeBin();
  });
  afterEach(() => bin.restore());

  it("treats exit 1 with findings as a successful run and passes the generated config", async () => {
    bin.install("ruff", replay("findings", 1));
    bin.onPathFirst();

    const result = await runRuff(config, ["findings.py"]);

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toEqual([expect.objectContaining(naming)]);
    expect(readFileSync(join(bin.dir, "seen.toml"), "utf-8")).toBe('[lint]\nselect = ["N"]\n');
  });

  it("returns no diagnostics and no failures for a clean run", async () => {
    bin.install("ruff", replay("clean", 0));
    bin.onPathFirst();

    const result = await runRuff(config, ["clean.py"]);

    expect(result).toMatchObject({ diagnostics: [], failures: [], exitCode: 0 });
  });

  it.each([
    ["ruff 0.16.8 (code \"invalid-syntax\")", "syntax-error", "Expected a parameter or the end of the parameter list; Expected `)`, found newline"],
    ["ruff 0.9.10 (null code)", "syntax-error-ruff-0.9.10", "SyntaxError: Expected a parameter or the end of the parameter list; SyntaxError: Expected ')', found newline"],
  ])("reports a file %s could not parse once, beside the other findings", async (_label, name, message) => {
    bin.install("ruff", replay(name, 1));
    bin.onPathFirst();

    const result = await runRuff(config, ["findings.py", "broken.py"]);

    expect(result.diagnostics).toEqual([expect.objectContaining(naming)]);
    expect(result.failures).toEqual([{ tool: "ruff", kind: "file-not-checked", file: "/project/broken.py", message }]);
  });

  it("reports a file ruff could not read, which it mentions only on stderr", async () => {
    bin.install("ruff", replay("missing-file", 1));
    bin.onPathFirst();

    const result = await runRuff(config, ["findings.py", "nope.py"]);

    expect(result.diagnostics).toEqual([expect.objectContaining(naming)]);
    expect(result.failures).toEqual([
      { tool: "ruff", kind: "file-not-checked", file: "nope.py", message: "No such file or directory (os error 2)" },
    ]);
  });

  it("does not report ruff's benign 'No Python files found' warning as a file not checked", async () => {
    bin.install("ruff", replay("empty-dir", 0));
    bin.onPathFirst();

    const result = await runRuff(config, ["/empty"]);

    expect(result).toMatchObject({ diagnostics: [], failures: [], exitCode: 0 });
  });

  it("reports an invalid configuration (exit 2) as an exit-code failure with ruff's message", async () => {
    bin.install("ruff", replay("bad-config", 2));
    bin.onPathFirst();

    const result = await runRuff(config, ["clean.py"]);

    expect(result.failures).toEqual([expect.objectContaining({ tool: "ruff", kind: "exit-code" })]);
    expect(result.failures[0]!.message).toMatch(/exited with code 2: ruff failed\n {2}Cause: Failed to load configuration/);
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
