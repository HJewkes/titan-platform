import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, unitRootOf } from "./cli.js";
import { FIXTURE_ROOT } from "./test-fixtures.js";

function captureStdout(): () => string {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (lines.push(String(chunk)), true));
  return () => lines.join("\n");
}

describe("titan-evals", () => {
  let scratch: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("prints help naming the validate command when run with no arguments", async () => {
    const output = captureStdout();

    const code = await runCli([]);

    expect(code).toBe(0);
    expect(output()).toMatch(/Usage: titan-evals[\s\S]*validate/);
  });

  it("resolves a variant's prompts from the unit directory above it", () => {
    expect(unitRootOf(`${FIXTURE_ROOT}variants/single-pass.json`)).toBe(FIXTURE_ROOT.replace(/\/$/, ""));
  });

  it("prints a hash per spec and exits 0 when every prompt digest is current", async () => {
    const output = captureStdout();

    const code = await runCli(["validate", `${FIXTURE_ROOT}unit.json`, `${FIXTURE_ROOT}variants/single-pass.json`]);

    expect(code).toBe(0);
    expect(output()).toMatch(/^[0-9a-f]{64} {2}titan\.unit\/v1/m);
    expect(output()).toMatch(/^[0-9a-f]{64} {2}titan\.variant\/v1/m);
  });

  it("exits 1 and marks the spec stale when a prompt file was edited", async () => {
    scratch = mkdtempSync(join(tmpdir(), "titan-evals-"));
    cpSync(FIXTURE_ROOT, scratch, { recursive: true });
    writeFileSync(join(scratch, "prompts", "summarize.md"), "An edited prompt.\n");
    const output = captureStdout();

    const code = await runCli(["validate", join(scratch, "variants", "single-pass.json")]);

    expect(code).toBe(1);
    expect(output()).toMatch(/STALE prompt digest/);
  });
});
