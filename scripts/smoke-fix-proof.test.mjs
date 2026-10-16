import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USAGE, options } from "./smoke-fix-proof.mjs";

const SCRIPT = fileURLToPath(new URL("./smoke-fix-proof.mjs", import.meta.url));
const HEAD = "c".repeat(40);

describe("smoke-fix-proof options", () => {
  it("accepts an existing PR with its head and defaults to a dry run", () => {
    expect(options(["--repo", "HJewkes/titan-platform", "--pr", "12", "--head", HEAD])).toMatchObject({ pr: 12, head: HEAD, open: false, run: false, timeoutMs: 40 * 60_000 });
  });

  it("accepts --open with an implementer and no PR", () => {
    expect(options(["--open", "--repo", "HJewkes/titan-platform", "--implementer", "tc-tp-538-a"])).toMatchObject({ open: true, pr: null, implementer: "tc-tp-538-a" });
  });

  it.each([
    ["no head for an existing PR", ["--repo", "HJewkes/titan-platform", "--pr", "12"]],
    ["a short head", ["--repo", "HJewkes/titan-platform", "--pr", "12", "--head", "abc"]],
    ["--open without an implementer", ["--open", "--repo", "HJewkes/titan-platform"]],
    ["--open together with a PR", ["--open", "--repo", "HJewkes/titan-platform", "--implementer", "x", "--pr", "12"]],
    ["a repo without an owner", ["--repo", "titan-platform", "--pr", "12", "--head", HEAD]],
    ["a zero timeout", ["--repo", "HJewkes/titan-platform", "--pr", "12", "--head", HEAD, "--timeout-min", "0"]],
  ])("rejects %s with the usage line", (_, argv) => {
    expect(() => options(argv)).toThrow(USAGE);
  });
});

describe("smoke-fix-proof dry run", () => {
  it("lists the fixture steps without pushing, opening or registering anything", () => {
    const out = JSON.parse(execFileSync("node", [SCRIPT, "--open", "--repo", "HJewkes/titan-platform", "--implementer", "tc-tp-538-a"], { encoding: "utf8" }));

    expect(out.dryRun).toBe(true);
    expect(out.steps.join("\n")).toMatch(/draft PR[\s\S]*--kind correctness[\s\S]*shepherd hold/);
  });
});
