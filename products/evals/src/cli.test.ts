import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fixProof from "@titan-design/fix-proof";
import { runCli, unitRootOf } from "./cli.js";
import * as exclusion from "./private/exclusion.js";
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

  it("reports a missing file and a schema error by name and exits 1 instead of throwing", async () => {
    scratch = mkdtempSync(join(tmpdir(), "titan-evals-"));
    writeFileSync(join(scratch, "bad.json"), JSON.stringify({ schema: "titan.unit/v1", id: "Not Kebab" }));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));

    const code = await runCli(["validate", join(scratch, "missing.json"), join(scratch, "bad.json")]);

    expect(code).toBe(1);
    expect(errors).toEqual([expect.stringMatching(/missing\.json: .*ENOENT/), expect.stringMatching(/bad\.json: /)]);
  });

  it("returns 1 then 0 for a failing then a passing run in one process without touching process.exitCode", async () => {
    scratch = mkdtempSync(join(tmpdir(), "titan-evals-"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    captureStdout();

    const failing = await runCli(["validate", join(scratch, "missing.json")]);
    const passing = await runCli(["validate", `${FIXTURE_ROOT}unit.json`]);

    expect([failing, passing]).toEqual([1, 0]);
    expect(process.exitCode).toBeUndefined();
  });

  it("returns the usage code 2 for an unknown command and for a missing argument", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await runCli(["bogus"])).toBe(2);
    expect(await runCli(["validate"])).toBe(2);
  });

  it("returns 0 for the help subcommand and the --help flag", async () => {
    captureStdout();

    expect(await runCli(["help"])).toBe(0);
    expect(await runCli(["help", "validate"])).toBe(0);
    expect(await runCli(["validate", "--help"])).toBe(0);
  });

  it("refuses a review-pr cases --out inside a git work tree and writes nothing there", async () => {
    scratch = mkdtempSync(join(tmpdir(), "titan-evals-"));
    writeFileSync(join(scratch, "corpus.jsonl"), "");
    const insideRepo = join(FIXTURE_ROOT, "..", "review-pr-private-out");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));

    const code = await runCli(["review-pr", "cases", "--corpus", join(scratch, "corpus.jsonl"), "--active-work-root", scratch, "--out", insideRepo]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/inside a git work tree/);
    expect(existsSync(insideRepo)).toBe(false);
  });

  it("an out dir inside a work tree exits 1", async () => {
    scratch = mkdtempSync(join(tmpdir(), "titan-evals-"));
    writeFileSync(join(scratch, "corpus.jsonl"), "");
    const insideRepo = join(FIXTURE_ROOT, "..", "implement-task-private-out");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));

    const code = await runCli(["implement-task", "export", "--corpus", join(scratch, "corpus.jsonl"), "--active-work-root", scratch, "--out", insideRepo]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/inside a git work tree/);
    expect(existsSync(insideRepo)).toBe(false);
  });

  it("dry run calls no execSide", async () => {
    scratch = mkdtempSync(join(tmpdir(), "titan-evals-"));
    writeFileSync(join(scratch, "corpus.jsonl"), "");
    const execSide = vi.spyOn(fixProof, "execSide");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));

    const code = await runCli(["implement-task", "export", "--dry-run", "--corpus", join(scratch, "corpus.jsonl"), "--active-work-root", scratch]);

    expect(code).toBe(0);
    expect(execSide).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/dryRun/);
  });

  it("selftest failure aborts before any write", async () => {
    scratch = mkdtempSync(join(tmpdir(), "titan-evals-"));
    writeFileSync(join(scratch, "corpus.jsonl"), "");
    const out = join(scratch, "out");
    vi.spyOn(exclusion, "selfTest").mockReturnValue({ ok: false, survivors: [], assertMissed: ["planted-1"], privateInitiatives: 0 });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));

    const code = await runCli(["implement-task", "export", "--selftest", "--corpus", join(scratch, "corpus.jsonl"), "--active-work-root", scratch, "--out", out]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/self-test failed/);
    expect(existsSync(out)).toBe(false);
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
