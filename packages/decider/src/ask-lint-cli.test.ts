import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAskLint } from "./ask-lint-cli.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ask-lint");
const BEFORE = path.join(DIR, "2026-10-04-before.md");
const AFTER = path.join(DIR, "vc-65-after.md");
const PLAN = path.join(DIR, "plan-owner-questions.md");

function run(...argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAskLint(argv, {
    readFile: (file) => readFileSync(file, "utf-8"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

const linesFor = (out: readonly string[], id: string) => out.filter((line) => line.startsWith(`${id} `));

describe("ask-lint on a Morning list", () => {
  it("prints one id, rule and evidence line per finding for vc-65 before the contract", () => {
    const { code, out, err } = run(BEFORE);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(linesFor(out, "vc-65").map((line) => line.split(" ")[1])).toEqual(["AQ1", "AQ2", "AQ3", "AQ4"]);
    expect(linesFor(out, "vc-65")[0]).toMatch(/^vc-65 AQ1 .*"6 Qs"/);
  });

  it("prints nothing for vc-65 rewritten under the contract", () => {
    expect(run(AFTER)).toEqual({ code: 0, out: [], err: [] });
  });

  it("exits 1 under --strict only when a finding exists", () => {
    expect(run(BEFORE, "--strict").code).toBe(1);
    expect(run(AFTER, "--strict").code).toBe(0);
  });

  it("prints one JSON object per finding with the same fields under --json", () => {
    const plain = run(BEFORE).out;
    const json = run(BEFORE, "--json").out.map((line) => JSON.parse(line) as Record<string, string>);

    expect(json).toHaveLength(plain.length);
    expect(json[0] && Object.keys(json[0])).toEqual(["id", "rule", "evidence"]);
    expect(json.map(({ id, rule, evidence }) => `${id} ${rule} ${evidence}`)).toEqual(plain);
  });
});

describe("ask-lint --section on a plan", () => {
  it("lints only the named section's entries", () => {
    const { code, out } = run(PLAN, "--section", "Owner questions", "--strict");

    expect(code).toBe(1);
    expect(linesFor(out, "1")).toEqual([]);
    expect(linesFor(out, "2").map((line) => line.split(" ")[1])).toEqual(["AQ1", "AQ2", "AQ3", "AQ5"]);
    expect(out.every((line) => line.startsWith("2 "))).toBe(true);
  });

  it("lints a section under any heading the caller names", () => {
    const { out } = run(PLAN, "--section", "3. Slices");

    expect(out.map((line) => line.split(" ").slice(0, 2).join(" "))).toContain("1 AQ1");
  });
});

describe("ask-lint errors", () => {
  it.each([
    ["a missing file", [path.join(DIR, "no-such-file.md")]],
    ["a missing section heading", [PLAN, "--section", "Risks"]],
    ["no file argument", []],
    ["an unknown option", [BEFORE, "--fix"]],
  ])("exits 2 with one stderr line on %s", (_, argv) => {
    const { code, out, err } = run(...argv);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^ask-lint: /);
  });
});
