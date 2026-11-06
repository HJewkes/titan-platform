import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { USAGE, ghWrite, openFixture, options, register } from "./smoke-fix-proof.mjs";

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
    expect(out.steps.join("\n")).toMatch(/draft PR[\s\S]*--kind correctness/);
    expect(out.steps.join("\n")).not.toMatch(/shepherd hold/);
  });
});

describe("smoke-fix-proof gh writes", () => {
  const created = JSON.stringify({ number: 7, html_url: "https://example.test/pr/7" });
  const fakeIo = () => ({ git: vi.fn(() => "d".repeat(40)), run: vi.fn(() => created), commit: vi.fn(() => "e".repeat(40)) });
  const base = { repo: "owner/repo", branch: null };

  it("sends gh writes through agent-chat gh-write", () => {
    const exec = vi.fn(() => "");

    ghWrite(["pr", "close", "7"], exec);

    expect(exec).toHaveBeenCalledWith("agent-chat", ["gh-write", "--", "pr", "close", "7"]);
  });

  it("creates the fixture PR via gh-write and never calls gh directly", () => {
    const io = fakeIo();

    openFixture(base, io);

    expect(io.run).toHaveBeenCalledTimes(1);
    expect(io.run.mock.calls[0][0]).toBe("agent-chat");
    expect(io.run.mock.calls[0][1].slice(0, 5)).toEqual(["gh-write", "--", "api", "-X", "POST"]);
  });

  it("opens the PR from an existing branch without pushing", () => {
    const io = fakeIo();

    const fixture = openFixture({ ...base, branch: "fix/tp-538-fixture-abc123" }, io);

    expect(io.git.mock.calls.map(([args]) => args[0])).not.toContain("push");
    expect(io.commit).not.toHaveBeenCalled();
    expect(io.run.mock.calls[0][1]).toContain("head=fix/tp-538-fixture-abc123");
    expect(fixture).toMatchObject({ pr: 7, head: "d".repeat(40), branch: "fix/tp-538-fixture-abc123" });
  });

  it("accepts --branch only together with --open", () => {
    expect(options(["--open", "--repo", "o/r", "--implementer", "x", "--branch", "fix/a"]).branch).toBe("fix/a");
    expect(() => options(["--repo", "o/r", "--pr", "1", "--head", HEAD, "--branch", "fix/a"])).toThrow(USAGE);
  });
});

describe("smoke-fix-proof shepherd registration", () => {
  it("registers the fixture with a never-merge policy and issues no hold", () => {
    const exec = vi.fn(() => "");

    register({ repo: "HJewkes/titan-platform", implementer: "agent-x", task: "titan-platform/TP-538" }, { pr: 7 }, exec);

    expect(exec).toHaveBeenCalledTimes(1);
    const [args] = exec.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(["register", "HJewkes/titan-platform#7", "--kind"]);
    expect(args).toContain('{"merge":"never"}');
    expect(args).not.toContain("hold");
  });
});
