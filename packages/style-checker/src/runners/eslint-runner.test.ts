import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runEslint } from "./eslint-runner.js";
import { generateEslintConfig } from "../generators/eslint.js";
import { createFakeBin, heredoc } from "../test-support/fake-bin.js";
import type { FakeBin } from "../test-support/fake-bin.js";
import type { Profile } from "@titan-design/style-profile";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const sampleFile = join(packageDir, "fixtures/eslint/sample.ts");
const brokenFile = join(packageDir, "fixtures/eslint/broken.ts");

const profile: Profile = {
  schemaVersion: "1.0.0",
  author: "testuser",
  generated: "2026-09-18",
  sources: [],
  naming: { variables: { convention: "camelCase", confidence: 0.94, stability: "high" } },
  structure: { functionMaxLines: { convention: 3, confidence: 0.7 } },
  documentation: {},
  errorHandling: {},
  formatting: {},
  patterns: {},
  idioms: { detected: [] },
  antiPatterns: { acknowledged: [] },
  overrides: [],
  severityThresholds: { error: 0.85, warn: 0.6, info: 0.4 },
};

describe("runEslint with the real ESLint devDependency", () => {
  it("loads the generated config and returns normalized diagnostics", async () => {
    const result = await runEslint(generateEslintConfig(profile), [sampleFile], { cwd: packageDir });

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: sampleFile, line: 1, column: 7, severity: "error", category: "naming",
        rule: "@typescript-eslint/naming-convention", fixable: false,
      }),
      expect.objectContaining({
        file: sampleFile, line: 3, column: 8, severity: "warn", category: "structure",
        rule: "max-lines-per-function",
      }),
    ]);
  }, 60_000);

  it("reports a file ESLint could not parse as a failure, not as clean", async () => {
    const result = await runEslint(generateEslintConfig(profile), [brokenFile], { cwd: packageDir });

    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ tool: "eslint", kind: "file-not-checked", file: brokenFile }),
    ]);
    expect(result.failures[0]!.message).toMatch(/Parsing error/);
  }, 60_000);
});

describe("runEslint when the ESLint process fails", () => {
  let bin: FakeBin;
  const config = generateEslintConfig(profile);
  const run = (timeout?: number) => runEslint(config, [sampleFile], { cwd: packageDir, timeout });

  beforeEach(() => {
    bin = createFakeBin();
  });
  afterEach(() => bin.restore());

  it("reports a configuration error (exit 2, nothing on stdout) as an exit-code failure", async () => {
    bin.install("npx", `${heredoc('A configuration object specifies rule "x/y", but could not find plugin "x".', "stderr")}\nexit 2`);
    bin.onPathFirst();

    const result = await run();

    expect(result.diagnostics).toEqual([]);
    expect(result.exitCode).toBe(2);
    expect(result.failures).toEqual([expect.objectContaining({ tool: "eslint", kind: "exit-code" })]);
    expect(result.failures[0]!.message).toMatch(/exited with code 2: .*could not find plugin "x"/);
  });

  it("treats exit 1 with findings as a successful run", async () => {
    const stdout = JSON.stringify([{ filePath: "/p/a.ts", messages: [
      { ruleId: "max-lines-per-function", severity: 1, message: "too long", line: 2, column: 1 },
    ] }]);
    bin.install("npx", `${heredoc(stdout)}\nexit 1`);
    bin.onPathFirst();

    const result = await run();

    expect(result.failures).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ file: "/p/a.ts", rule: "max-lines-per-function" })]);
  });

  it("reports output that is not JSON as unparseable", async () => {
    bin.install("npx", `${heredoc("Oops! Something went wrong!")}\nexit 0`);
    bin.onPathFirst();

    const result = await run();

    expect(result.failures).toEqual([expect.objectContaining({ kind: "unparseable-output" })]);
  });

  it("reports a successful exit with no output as unparseable, not as clean", async () => {
    bin.install("npx", "exit 0");
    bin.onPathFirst();

    const result = await run();

    expect(result.failures).toEqual([expect.objectContaining({ kind: "unparseable-output" })]);
    expect(result.failures[0]!.message).toMatch(/exited 0 with no output/);
  });

  it("reports a child killed by a signal", async () => {
    bin.install("npx", "kill -9 $$");
    bin.onPathFirst();

    const result = await run();

    expect(result.exitCode).toBeNull();
    expect(result.failures).toEqual([expect.objectContaining({ kind: "signal" })]);
    expect(result.failures[0]!.message).toMatch(/SIGKILL/);
  });

  it("reports a run that outlives its timeout", async () => {
    bin.install("npx", "exec sleep 5");
    bin.onPathFirst();

    const result = await run(200);

    expect(result.failures).toEqual([expect.objectContaining({ kind: "timeout" })]);
  });

  it("reports a missing npx as a spawn failure", async () => {
    bin.onPathOnly();

    const result = await run();

    expect(result.failures).toEqual([expect.objectContaining({ kind: "spawn-failed" })]);
    expect(result.failures[0]!.message).toMatch(/Failed to spawn npx/);
  });
});
