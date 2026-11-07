import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../run-command.js";
import { scratchLockfileRegen, type LockfileTree } from "./lockfile-regen.js";

interface RunCall {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  treeOnDisk: string | null;
}

const FAKE_GH = `ghp_${"a1B2".repeat(9)}`;
const FAKE_NPM = `npm_${"c3D4".repeat(9)}`;
const FAKE_SK = `sk-${"e5F6".repeat(6)}`;

function pnpmLock(version: string, body = "importers: {}"): string {
  return `lockfileVersion: '${version}'\n\n${body}\n`;
}

function pnpmTree(files: Record<string, string> = {}, manifest: object = { packageManager: "pnpm@10.28.1+sha512.abc123" }): LockfileTree {
  return { kind: "pnpm", files: { "package.json": JSON.stringify(manifest), "pnpm-lock.yaml": pnpmLock("9.0"), ...files } };
}

/** A fake runCommand that writes `lockfile` into the scratch dir the way a real install would. */
function fakeRun(lockfile: { path: string; text: string } | null, result: CommandResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: RunCall[] = [];
  const run = vi.fn((file: string, args: readonly string[], cwd: string, _timeout: number, env: NodeJS.ProcessEnv) => {
    const manifest = join(cwd, "package.json");
    calls.push({ file, args, cwd, env, treeOnDisk: existsSync(manifest) ? readFileSync(manifest, "utf8") : null });
    if (lockfile) writeFileSync(join(cwd, lockfile.path), lockfile.text);
    return Promise.resolve(result);
  });
  return { run, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scratchLockfileRegen", () => {
  it("runs corepack pnpm@<packageManager> install --lockfile-only --ignore-scripts --ignore-pnpmfile in a scratch dir", async () => {
    const regenerated = pnpmLock("9.0", "importers:\n  .: {}");
    const { run, calls } = fakeRun({ path: "pnpm-lock.yaml", text: regenerated });
    const tree = pnpmTree();

    const changed = await scratchLockfileRegen(run)(tree);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("corepack");
    expect(calls[0]?.args).toEqual(["pnpm@10.28.1", "install", "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile"]);
    expect(calls[0]?.treeOnDisk).toBe(tree.files["package.json"]);
    expect(existsSync(calls[0]?.cwd ?? "")).toBe(false);
    expect(changed).toEqual({ "pnpm-lock.yaml": regenerated });
  });

  it("passes an env with no GH_TOKEN, GITHUB_TOKEN, NPM_TOKEN or NODE_AUTH_TOKEN", async () => {
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN"]) vi.stubEnv(key, FAKE_GH);
    vi.stubEnv("npm_config_//registry.npmjs.org/:_authToken", FAKE_NPM);
    vi.stubEnv("OPENAI_API_KEY", FAKE_SK);
    vi.stubEnv("npm_config_registry", "https://registry.npmjs.org/");
    const { run, calls } = fakeRun({ path: "pnpm-lock.yaml", text: pnpmLock("9.0") });

    await scratchLockfileRegen(run)(pnpmTree());

    const env = calls[0]?.env ?? {};
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN"]) expect(env).not.toHaveProperty([key]);
    expect(JSON.stringify(env)).not.toContain(FAKE_GH);
    expect(JSON.stringify(env)).not.toContain(FAKE_NPM);
    expect(JSON.stringify(env)).not.toContain(FAKE_SK);
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(env.npm_config_userconfig).toBe(join(calls[0]?.cwd ?? "", ".lockfile-regen-userconfig"));
  });

  it("throws with stderr and removes the scratch dir when the install fails", async () => {
    const stderr = `ERR_PNPM_FETCH_401 GET https://registry.npmjs.org/@titan-design%2fexample-a: Unauthorized ${FAKE_GH}`;
    const { run, calls } = fakeRun(null, { code: 1, stdout: "", stderr });

    const error = await scratchLockfileRegen(run)(pnpmTree()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exited 1: ERR_PNPM_FETCH_401 .*Unauthorized \[redacted\]$/);
    expect((error as Error).message).not.toContain(FAKE_GH);
    expect(existsSync(calls[0]?.cwd ?? "")).toBe(false);
  });

  it("throws and returns no files when lockfileVersion changed", async () => {
    const { run, calls } = fakeRun({ path: "pnpm-lock.yaml", text: pnpmLock("10.0") });

    const regen = scratchLockfileRegen(run)(pnpmTree());

    await expect(regen).rejects.toThrow("lockfileVersion changed from 9.0 to 10.0");
    expect(existsSync(calls[0]?.cwd ?? "")).toBe(false);
  });

  it.each([
    ["a root .pnpmfile.cjs", pnpmTree({ ".pnpmfile.cjs": "module.exports = {};" }), /\.pnpmfile\.cjs/],
    ["a pnpmfile named by pnpm-workspace.yaml", pnpmTree({ "pnpm-workspace.yaml": "pnpmfile: hooks/x.cjs\n" }), /names a pnpmfile/],
    ["a package.json patch it did not read", pnpmTree({}, { pnpm: { patchedDependencies: { "example-a@1.0.0": "patches/example-a.patch" } } }), /unread patch files: patches\/example-a\.patch/],
    ["a pnpm-workspace.yaml patch it did not read", pnpmTree({ "pnpm-workspace.yaml": "patchedDependencies:\n  example-b@2.0.0: patches/example-b.patch\n" }), /unread patch files: patches\/example-b\.patch/],
  ])("refuses a tree with .pnpmfile.cjs or unread patch files before running: %s", async (_name, tree, message) => {
    const { run } = fakeRun({ path: "pnpm-lock.yaml", text: pnpmLock("9.0") });

    await expect(scratchLockfileRegen(run)(tree)).rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a tree whose patch files were read, writing them into the scratch dir", async () => {
    const patch = "diff --git a/index.js b/index.js\n";
    const tree = pnpmTree({ "patches/example-a.patch": patch }, { pnpm: { patchedDependencies: { "example-a@1.0.0": "patches/example-a.patch" } } });
    const { run, calls } = fakeRun({ path: "pnpm-lock.yaml", text: pnpmLock("9.0") });

    const changed = await scratchLockfileRegen(run)(tree);

    expect(calls[0]?.file).toBe("pnpm");
    expect(changed).toEqual({});
  });

  it("uses npm install --package-lock-only for an npm tree", async () => {
    const before = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } });
    const after = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@titan-design/example-a": { version: "0.2.0" } } });
    const tree: LockfileTree = { kind: "npm", files: { "package.json": "{}", "package-lock.json": before } };
    const { run, calls } = fakeRun({ path: "package-lock.json", text: after });

    const changed = await scratchLockfileRegen(run)(tree);

    expect(calls.map((call) => [call.file, ...call.args])).toEqual([["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    expect(changed).toEqual({ "package-lock.json": after });
  });

  it("refuses a packageManager pin that is not a plain pnpm version, and a tree path outside the dir", async () => {
    const { run } = fakeRun(null);

    await expect(scratchLockfileRegen(run)(pnpmTree({}, { packageManager: "pnpm@--global" }))).rejects.toThrow(/not a plain pnpm@x\.y\.z pin/);
    await expect(scratchLockfileRegen(run)(pnpmTree({ "../escape.txt": "x" }))).rejects.toThrow(/refusing tree path/);
    expect(run).not.toHaveBeenCalled();
  });
});
