import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseResultLine } from "../packages/fix-proof/src/result-line.ts";

const script = path.join(import.meta.dirname, "fix-proof-run.sh");
const base = "a".repeat(40);
const head = "b".repeat(40);

describe("fix-proof-run.sh", () => {
  let runner;
  beforeEach(() => {
    runner = mkdtempSync(path.join(tmpdir(), "fix-proof-run-"));
    mkdirSync(path.join(runner, "packages/fix-proof/dist"), { recursive: true });
  });
  afterEach(() => rmSync(runner, { recursive: true, force: true }));

  const run = () => spawnSync("bash", [script, runner, base, head], { encoding: "utf8" });

  it("prints a parseable skipped line and passes when the merge-base build left no bin.js", () => {
    writeFileSync(path.join(runner, "packages/fix-proof/dist/index.js"), "export {};\n");

    const result = run();

    expect(result.status).toBe(0);
    const parsed = parseResultLine(result.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toMatchObject({ head, mergeBase: base, error: "skipped: no runner at merge base" });
  });

  it("passes when the whole package is absent at the merge base", () => {
    rmSync(path.join(runner, "packages"), { recursive: true });

    const result = run();

    expect(result.status).toBe(0);
    expect(parseResultLine(result.stdout.trim()).ok).toBe(true);
  });

  it("runs the merge-base bin with the base and head when it exists", () => {
    writeFileSync(path.join(runner, "packages/fix-proof/dist/bin.js"), "console.log(process.argv.slice(2).join(' '));\n");

    const result = run();

    expect(result.stdout.trim()).toBe(`run --base ${base} --head ${head}`);
  });
});
