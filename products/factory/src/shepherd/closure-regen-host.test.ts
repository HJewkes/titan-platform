import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../run-command.js";
import type { GitResult } from "./carry-cache-ports.js";
import { sandboxedClosureRegen } from "./closure-regen-host.js";
import { CLOSURE_LOCK_PATH } from "./lock-regen.js";

const GIT_DIR = "/state/git-cache/octo/demo.git";
const MERGE = fakeSha("unresolved-merge");
const BLOB = fakeSha("lock-blob");
const TREE = fakeSha("regenerated-tree");
const HASH = "a".repeat(64);
const LOCK = { "ci-wait": { closure: HASH, schemaHash: HASH, bump: 3 } };

interface RunCall {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

type LockWrite = (work: string) => void;

const writeLock = (text: string): LockWrite => (work) => {
  mkdirSync(dirname(join(work, CLOSURE_LOCK_PATH)), { recursive: true });
  writeFileSync(join(work, CLOSURE_LOCK_PATH), text);
};

/** A host whose bwrap plays the sandbox: the lock-writing step leaves `lock` in the mounted work dir. */
function fakeHost(lock: LockWrite = writeLock(JSON.stringify(LOCK)), failing?: string) {
  const gitCalls: (readonly string[])[] = [];
  const runs: RunCall[] = [];
  const git = async (_dir: string, args: readonly string[]): Promise<GitResult> => (gitCalls.push(args), { code: 0, stdout: "", stderr: "" });
  const run = async (file: string, args: readonly string[], _cwd: string, _timeout: number, env: NodeJS.ProcessEnv): Promise<CommandResult> => {
    runs.push({ file, args, env });
    const command = args.slice(args.indexOf("--") + 1).join(" ");
    if (failing !== undefined && command.includes(failing)) return { code: 1, stdout: "", stderr: "boom" };
    if (command.startsWith("node scripts/step-closure-check.mjs")) lock(args[args.indexOf("/work") - 1]!);
    const out = args[0] === "hash-object" ? BLOB : args[0] === "write-tree" ? TREE : "";
    return { code: 0, stdout: `${out}\n`, stderr: "" };
  };
  return { regen: sandboxedClosureRegen(git, run), gitCalls, runs };
}

const sandboxed = (runs: RunCall[]) => runs.filter((call) => call.file === "bwrap");
const gitRuns = (runs: RunCall[]) => runs.filter((call) => call.file === "git").map((call) => call.args);
const scratchOf = (gitCalls: (readonly string[])[]): string => dirname(String(gitCalls[0]?.at(-2)));

describe("the host's closure.lock.json regeneration", () => {
  it("runs every branch command inside a sandbox with no network past the install and none of the host's environment", async () => {
    const host = fakeHost();

    await host.regen({ gitDir: GIT_DIR, commit: MERGE });

    const steps = sandboxed(host.runs);
    expect(steps.map((call) => call.args.slice(call.args.indexOf("--") + 1)[0])).toEqual(["tar", "pnpm", "pnpm", "node"]);
    expect(steps.every((call) => call.args.includes("--unshare-all") && call.args.includes("--clearenv"))).toBe(true);
    expect(steps.map((call) => call.args.includes("--share-net"))).toEqual([false, true, false, false]);
    expect(steps.every((call) => !call.args.includes(homedir()) && !call.args.includes(GIT_DIR))).toBe(true);
    expect(steps.every((call) => Object.keys(call.env).join() === "PATH")).toBe(true);
  });

  it("exports the merge as a tar instead of a worktree of the cache, and removes the scratch tree", async () => {
    const host = fakeHost();

    await host.regen({ gitDir: GIT_DIR, commit: MERGE });

    expect(host.gitCalls.map((args) => args[0])).toEqual(["archive"]);
    expect(host.gitCalls[0]).toEqual(["archive", "--format=tar", "-o", expect.stringMatching(/merge\.tar$/), MERGE]);
    expect(existsSync(scratchOf(host.gitCalls))).toBe(false);
  });

  it("writes the merge's tree with only the lock's blob swapped, through a private index", async () => {
    const host = fakeHost();

    const tree = await host.regen({ gitDir: GIT_DIR, commit: MERGE });

    expect(gitRuns(host.runs).map((args) => args[0])).toEqual(["hash-object", "read-tree", "update-index", "write-tree"]);
    expect(gitRuns(host.runs)[1]).toEqual(["read-tree", MERGE]);
    expect(gitRuns(host.runs)[2]).toEqual(["update-index", "--add", "--cacheinfo", `100644,${BLOB},${CLOSURE_LOCK_PATH}`]);
    expect(host.runs.find((call) => call.file === "git")?.env).toMatchObject({ GIT_DIR, GIT_INDEX_FILE: expect.stringMatching(/index$/) });
    expect(tree).toBe(TREE);
  });

  it("stops at a failed build, names only the step, and still removes the scratch tree", async () => {
    const host = fakeHost(undefined, "run build");

    await expect(host.regen({ gitDir: GIT_DIR, commit: MERGE })).rejects.toThrow(/^closure regen: build exited 1$/);
    expect(sandboxed(host.runs)).toHaveLength(3);
    expect(gitRuns(host.runs)).toEqual([]);
    expect(existsSync(scratchOf(host.gitCalls))).toBe(false);
  });

  it("refuses a lock the sandbox linked to a file outside the scratch tree", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "hosts.yml");
    writeFileSync(outside, JSON.stringify(LOCK));
    const host = fakeHost((work) => (mkdirSync(dirname(join(work, CLOSURE_LOCK_PATH)), { recursive: true }), symlinkSync(outside, join(work, CLOSURE_LOCK_PATH))));

    await expect(host.regen({ gitDir: GIT_DIR, commit: MERGE })).rejects.toThrow("closure regen: the regenerated lock resolves outside the scratch tree");
    expect(gitRuns(host.runs)).toEqual([]);
  });

  it("refuses a lock with fields a closure lock does not have", async () => {
    const host = fakeHost(writeLock(JSON.stringify({ "ci-wait": { ...LOCK["ci-wait"], note: "x" } })));

    await expect(host.regen({ gitDir: GIT_DIR, commit: MERGE })).rejects.toThrow("closure regen: the regenerated lock is not a closure lock");
    expect(gitRuns(host.runs)).toEqual([]);
  });
});
