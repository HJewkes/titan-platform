import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtureEnv, gitIn, seedRepoWithOrigin } from "@titan-design/test-kit/git";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { gitHooksEnv, passwdHome, writeGitHooks } from "./dir.js";
import { hookShell } from "./posix-shell.js";
import { termsFileFor } from "./pre-push.js";
import { defaultScanInputs, ownToolDirs, withOwnTools } from "./scan-path.js";

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "egress-scan-path-")));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const SYSTEM_PATH = "/usr/bin:/bin";
const NODE_DIR = path.dirname(process.execPath);
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
// Synthetic marker term; nothing real.
const LEAK = "zq7leakterm";

/** A fake install: node_modules/@titan-design/egress-scan linked to `packageDir`, its .bin link pointing where `binTarget` says. */
function fakeInstall(binTarget: "own" | "elsewhere", packageDir?: string): { resolve: (s: string) => string; binDir: string } {
  const nodeModules = path.join(fs.mkdtempSync(path.join(SCRATCH, "install-")), "node_modules");
  const installed = path.join(nodeModules, "@titan-design", "egress-scan");
  const binDir = path.join(nodeModules, ".bin");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.mkdirSync(binDir);
  if (packageDir === undefined) {
    fs.mkdirSync(path.join(installed, "dist"), { recursive: true });
    fs.writeFileSync(path.join(installed, "dist", "index.js"), "");
    fs.writeFileSync(path.join(installed, "dist", "bin.js"), "");
  } else {
    fs.symlinkSync(packageDir, installed);
  }
  fs.writeFileSync(path.join(SCRATCH, "other.js"), "");
  const target = binTarget === "own" ? path.join(installed, "dist", "bin.js") : path.join(SCRATCH, "other.js");
  fs.symlinkSync(target, path.join(binDir, "titan-egress-scan"));
  return { resolve: () => pathToFileURL(path.join(installed, "dist", "index.js")).href, binDir };
}

describe("ownToolDirs", () => {
  it("keeps a .bin dir whose titan-egress-scan is the resolved package", () => {
    const { resolve, binDir } = fakeInstall("own");

    expect(ownToolDirs(resolve)).toEqual([binDir, NODE_DIR]);
  });

  it("drops a .bin dir whose titan-egress-scan resolves elsewhere", () => {
    expect(ownToolDirs(fakeInstall("elsewhere").resolve)).toEqual([NODE_DIR]);
  });

  it("returns only node's dir when the scanner package cannot be resolved", () => {
    const resolve = (): string => {
      throw new Error("Cannot find package");
    };

    expect(ownToolDirs(resolve)).toEqual([NODE_DIR]);
  });

  it("returns only node's dir for a package that does not sit in node_modules", () => {
    const resolve = (): string => pathToFileURL(path.join(SCRATCH, "checkout", "egress-scan", "dist", "index.js")).href;

    expect(ownToolDirs(resolve)).toEqual([NODE_DIR]);
  });
});

describe("withOwnTools", () => {
  it("keeps the broker's entries first and adds each own dir once", () => {
    expect(withOwnTools("/opt/a:/usr/bin", ["/own/bin", "/usr/bin", "/own/bin"])).toBe("/opt/a:/usr/bin:/own/bin");
  });

  it("adds no relative dir", () => {
    expect(withOwnTools("/usr/bin", ["relative/bin", "."])).toBe("/usr/bin");
  });
});

describe("defaultScanInputs", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("bakes only the absolute PATH entries, then node's dir, and the passwd home", () => {
    vi.stubEnv("PATH", `relative/bin:${SYSTEM_PATH}::.`);

    const inputs = defaultScanInputs();

    expect(inputs.path.startsWith(`${SYSTEM_PATH}:`)).toBe(true);
    expect(inputs.path.split(":")).toContain(NODE_DIR);
    expect(inputs.path.split(":").every((dir) => path.isAbsolute(dir))).toBe(true);
    expect(inputs.home).toBe(passwdHome());
    expect(inputs.missingTermsRefuses).toBe(true);
  });
});

describe("git push when the broker PATH lacks titan-egress-scan", () => {
  function leakyRepo(root: string): { work: string; origin: string } {
    const work = path.join(root, "work");
    const origin = path.join(root, "origin.git");
    seedRepoWithOrigin(work, origin);
    const git = gitIn(work);
    git("checkout", "-q", "-b", "leaky");
    fs.writeFileSync(path.join(work, "notes.md"), `the ${LEAK} seat\n`);
    git("add", "notes.md");
    git("commit", "-q", "-m", "add notes");
    return { work, origin };
  }

  it("refuses a leaky push with the caller's own scanner instead of letting it through unscanned", () => {
    const onSystemPath = SYSTEM_PATH.split(":").some((dir) => fs.existsSync(path.join(dir, "titan-egress-scan")));
    if (onSystemPath) return;
    const root = fs.mkdtempSync(path.join(SCRATCH, "repo-"));
    const { work, origin } = leakyRepo(root);
    const owner = path.join(root, "owner-home");
    fs.mkdirSync(path.dirname(termsFileFor(owner)), { recursive: true });
    fs.writeFileSync(termsFileFor(owner), `${LEAK}\n`, { mode: 0o600 });
    const { resolve, binDir } = fakeInstall("own", PACKAGE_DIR);
    const inputs = { missingTermsRefuses: true, home: owner, path: withOwnTools(SYSTEM_PATH, ownToolDirs(resolve)) };
    const hooks = path.join(root, "git-hooks");
    writeGitHooks(hooks, inputs, { shell: hookShell(), shimDirs: [] });

    const run = spawnSync("git", ["push", "-q", "origin", "leaky"], { cwd: work, env: { ...fixtureEnv(), ...gitHooksEnv(hooks) }, encoding: "utf8" });

    expect(inputs.path).toBe(`${SYSTEM_PATH}:${binDir}:${NODE_DIR}`);
    expect(run.stderr).not.toContain("guard NOT run");
    // The hook prints this line only when the scanner exits 1, a finding.
    expect(run.stderr).toContain("leak-scan: only .egress-allow entries already on the remote's default branch count");
    expect(run.status).toBe(1);
    expect(gitIn(origin)("branch", "--list", "leaky")).toBe("");
  });
});
