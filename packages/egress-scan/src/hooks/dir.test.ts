import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureEnv, gitIn, seedRepo } from "@titan-design/test-kit/git";
import { afterAll, describe, expect, it } from "vitest";
import { CHAINED_HOOKS, gitHooksEnv, hooksDirOf, noRewriteHooksDir, probeScanner, STAMP_FILE, writeGitHooks } from "./dir.js";
import type { HookShell, ScanInputs, ScannerFacts } from "./pre-push.js";

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "egress-hooks-dir-")));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const SHELL: HookShell = { path: "/bin/sh", shebang: "#!/bin/sh", scrub: "command unset SHELLOPTS 2>/dev/null\n" };
const INPUTS: ScanInputs = { missingTermsRefuses: true, home: "/home/you", path: "/opt/tools/bin:/usr/bin:/bin" };
const POLICY = "no-rewrite push policy";

const scratch = (): string => fs.mkdtempSync(path.join(SCRATCH, "case-"));
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");

describe("writeGitHooks", () => {
  it("writes an executable pre-push and a chain shim for every chained hook", () => {
    const dir = path.join(scratch(), "git-hooks");

    writeGitHooks(dir, INPUTS, { shell: SHELL, shimDirs: [] });

    for (const name of ["pre-push", ...CHAINED_HOOKS]) expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o755);
    expect(read(dir, "pre-push")).toContain("titan-egress-scan pre-push");
    expect(read(dir, "pre-commit").startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("puts the no-rewrite policy only in the no-rewrite dir", () => {
    const shared = path.join(scratch(), "git-hooks");

    writeGitHooks(shared, INPUTS, { shell: SHELL, shimDirs: [] });
    writeGitHooks(noRewriteHooksDir(shared), INPUTS, { shell: SHELL, shimDirs: [] });

    expect(read(shared, "pre-push")).not.toContain(POLICY);
    expect(read(noRewriteHooksDir(shared), "pre-push")).toContain(POLICY);
  });

  it("leaves an unchanged hook file in place on a rewrite", () => {
    const dir = path.join(scratch(), "git-hooks");
    writeGitHooks(dir, INPUTS, { shell: SHELL, shimDirs: [] });
    const inode = fs.statSync(path.join(dir, "pre-push")).ino;

    writeGitHooks(dir, INPUTS, { shell: SHELL, shimDirs: [] });

    expect(fs.statSync(path.join(dir, "pre-push")).ino).toBe(inode);
  });

  it("bakes a PATH without the shim dirs", () => {
    const root = scratch();
    const shim = path.join(root, "git-bin");
    const dir = path.join(root, "git-hooks");

    writeGitHooks(dir, { ...INPUTS, path: `${shim}:/usr/bin` }, { shell: SHELL, shimDirs: [shim] });

    expect(read(dir, "pre-push")).toContain("PATH='/usr/bin'; export PATH");
  });

  it("refuses every push when the PATH holds nothing but shim dirs", () => {
    const root = scratch();
    const shim = path.join(root, "git-bin");

    writeGitHooks(path.join(root, "git-hooks"), { ...INPUTS, path: shim }, { shell: SHELL, shimDirs: [shim] });

    expect(read(path.join(root, "git-hooks"), "pre-push")).toContain("the broker PATH holds no directory but the agent shims");
  });
});

describe("writeGitHooks with a scanner probe", () => {
  const facts = (verdict: ScannerFacts["verdict"]): ScannerFacts => ({ scanner: "/opt/scan/bin.js", node: "/opt/node/bin/node", verdict, mtimeMs: 1_700_000_000_123 });

  it("writes a stamp just after the scanner's mtime and runs the baked node while it holds", () => {
    const dir = path.join(scratch(), "git-hooks");

    writeGitHooks(dir, { ...INPUTS, probe: () => facts("scans-text") }, { shell: SHELL, shimDirs: [] });

    expect(fs.statSync(path.join(dir, STAMP_FILE)).mtimeMs).toBeGreaterThan(1_700_000_000_123);
    expect(read(dir, "pre-push")).toContain("clean TITAN_EGRESS_TERMS='/home/you/.config/titan-egress/private-terms' TITAN_EGRESS_REQUIRE_TERMS=1 '/opt/node/bin/node' '/opt/scan/bin.js'");
  });

  it("removes the stamp and bakes nothing when the scanner skips binary files", () => {
    const dir = path.join(scratch(), "git-hooks");
    writeGitHooks(dir, { ...INPUTS, probe: () => facts("scans-text") }, { shell: SHELL, shimDirs: [] });

    writeGitHooks(dir, { ...INPUTS, probe: () => facts("skips-binary") }, { shell: SHELL, shimDirs: [] });

    expect(fs.existsSync(path.join(dir, STAMP_FILE))).toBe(false);
    expect(read(dir, "pre-push")).not.toContain("/opt/node/bin/node");
  });
});

describe("probeScanner", () => {
  function toolDir(help: string, ageMs: number): string {
    const bin = path.join(scratch(), "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    const scanner = path.join(bin, "titan-egress-scan");
    fs.writeFileSync(scanner, `console.log(${JSON.stringify(help)});\n`, { mode: 0o755 });
    const when = (Date.now() - ageMs) / 1000;
    fs.utimesSync(scanner, when, when);
    return bin;
  }

  it.each([
    ["pre-push <remote>; files are scanned as text", "scans-text"],
    ["pre-push <remote>", "skips-binary"],
    ["scan <range>", "no-pre-push"],
  ])("reads %j as %s", (help, verdict) => {
    const bin = toolDir(help, 60_000);

    expect(probeScanner(bin)).toMatchObject({ scanner: path.join(bin, "titan-egress-scan"), verdict });
  });

  it("bakes nothing for a scanner written within the last two seconds", () => {
    expect(probeScanner(toolDir("pre-push; scanned as text", 0))).toBeUndefined();
  });

  it("bakes nothing when the PATH has no scanner", () => {
    expect(probeScanner(scratch())).toBeUndefined();
  });
});

describe("gitHooksEnv", () => {
  it("names the dir hooksDirOf reads back", () => {
    expect(hooksDirOf(gitHooksEnv("/guard/git-hooks"))).toBe("/guard/git-hooks");
    expect(hooksDirOf({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/x" })).toBeUndefined();
  });

  it("chains a commit to the repo's own pre-commit hook, whose refusal stops it", () => {
    const root = scratch();
    const work = path.join(root, "work");
    seedRepo(work);
    const hooks = path.join(root, "git-hooks");
    writeGitHooks(hooks, INPUTS, { shell: SHELL, shimDirs: [] });
    fs.writeFileSync(path.join(work, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho own-pre-commit >&2\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(work, "a.md"), "a\n");
    gitIn(work)("add", "a.md");

    const out = spawnSync("git", ["commit", "-q", "-m", "a"], { cwd: work, env: { ...fixtureEnv(), ...gitHooksEnv(hooks) }, encoding: "utf8" });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("own-pre-commit");
  });
});
