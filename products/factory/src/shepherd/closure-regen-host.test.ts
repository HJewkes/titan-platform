import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../run-command.js";
import type { GitResult } from "./carry-cache-ports.js";
import { scratchClosureRegen } from "./closure-regen-host.js";
import { CLOSURE_LOCK_PATH } from "./lock-regen.js";

const GIT_DIR = "/state/git-cache/octo/demo.git";
const MERGE = fakeSha("unresolved-merge");
const TREE = fakeSha("regenerated-tree");
const FAKE_TOKEN = `ghp_${"a1B2".repeat(9)}`;

interface RunCall {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

afterEach(() => vi.unstubAllEnvs());

/** A cache git that records its calls, and a command runner where the command whose args start with `failing` exits 1. */
function fakeHost(failing?: string) {
  const gitCalls: (readonly string[])[] = [];
  const runs: RunCall[] = [];
  const git = async (_dir: string, args: readonly string[]): Promise<GitResult> => (gitCalls.push(args), { code: 0, stdout: "", stderr: "" });
  const run = async (file: string, args: readonly string[], cwd: string, _timeout: number, env: NodeJS.ProcessEnv): Promise<CommandResult> => {
    runs.push({ file, args, cwd, env });
    if (args[0] === failing) return { code: 1, stdout: "", stderr: `token ${FAKE_TOKEN} rejected` };
    return { code: 0, stdout: args[0] === "write-tree" ? `${TREE}\n` : "", stderr: "" };
  };
  return { regen: scratchClosureRegen(git, run), gitCalls, runs };
}

describe("the host's closure.lock.json regeneration", () => {
  it("rebuilds the lock in a worktree of the merge with no token in its env, and answers the staged tree", async () => {
    vi.stubEnv("GH_TOKEN", FAKE_TOKEN);
    const host = fakeHost();

    const tree = await host.regen({ gitDir: GIT_DIR, commit: MERGE });

    const checkout = host.gitCalls[0]?.at(-2);
    expect(host.gitCalls[0]).toEqual(["worktree", "add", "--detach", "--quiet", checkout, MERGE]);
    expect(host.runs.map((call) => call.args.join(" "))).toEqual([
      "install --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
      "--filter @titan-design/factory... run build",
      "scripts/step-closure-check.mjs --write",
      `add -- ${CLOSURE_LOCK_PATH}`,
      "write-tree",
    ]);
    expect(host.runs.every((call) => call.cwd === checkout && !JSON.stringify(call.env).includes(FAKE_TOKEN))).toBe(true);
    expect(tree).toBe(TREE);
    expect(host.gitCalls).toContainEqual(["worktree", "remove", "--force", checkout]);
  });

  it("stops at a failed build, names only the command, and still removes the worktree", async () => {
    const host = fakeHost("--filter");

    const failed = host.regen({ gitDir: GIT_DIR, commit: MERGE });

    await expect(failed).rejects.toThrow(/^closure regen: build exited 1$/);
    const checkout = host.gitCalls[0]?.at(-2);
    expect(host.runs).toHaveLength(2);
    expect(host.gitCalls).toContainEqual(["worktree", "remove", "--force", checkout]);
  });
});
