import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@titan-design/fix-proof";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyPreparedBase, prepareBase } from "./prepare.js";

const MERGE = "d".repeat(40);
let root: string;
let treeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bench-prepare-"));
  treeDir = join(root, "tree");
  mkdirSync(join(treeDir, "src"), { recursive: true });
  writeFileSync(join(treeDir, "src", "a.ts"), "export const a = 1;\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function recordingExec(statuses: Record<string, number> = {}): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const command = [file, ...args].join(" ");
    calls.push(command);
    return { status: statuses[command] ?? 0, stdout: "", stderr: `${command} output` };
  };
  return { exec, calls };
}

/** A tree that smuggles its own history: seeding commits on top of it, so the workspace holds two commits. */
function treeWithHistory(): void {
  const git = (...args: string[]) => execFileSync("git", ["-C", treeDir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "later history");
  writeFileSync(join(treeDir, "src", "b.ts"), "export const b = 2;\n");
}

describe("prepared base", () => {
  it("refuses a two-commit workspace before any install", async () => {
    treeWithHistory();
    const { exec, calls } = recordingExec();

    const preparing = prepareBase({ baseDir: join(root, "base"), treeDir, mergeSha: MERGE, exec });

    await expect(preparing).rejects.toThrow(/holds 2 commits/);
    expect(calls).toEqual([]);
  });

  it("seeds one commit, installs offline from the frozen lockfile, then builds", async () => {
    const { exec, calls } = recordingExec();

    const result = await prepareBase({ baseDir: join(root, "base"), treeDir, mergeSha: MERGE, exec });

    expect(result).toEqual({ verdict: "ready" });
    expect(calls).toEqual(["pnpm install --frozen-lockfile --offline", "pnpm build"]);
    expect(execFileSync("git", ["-C", join(root, "base"), "rev-list", "--all", "--count"], { encoding: "utf8" }).trim()).toBe("1");
  });

  it("marks a failed offline install infra-screen and builds nothing", async () => {
    const { exec, calls } = recordingExec({ "pnpm install --frozen-lockfile --offline": 1 });

    const result = await prepareBase({ baseDir: join(root, "base"), treeDir, mergeSha: MERGE, exec });

    expect(result.verdict).toBe("infra-screen");
    expect(calls).toHaveLength(1);
  });

  it("marks a failed build build-failed", async () => {
    const { exec } = recordingExec({ "pnpm build": 2 });

    const result = await prepareBase({ baseDir: join(root, "base"), treeDir, mergeSha: MERGE, exec });

    expect(result).toEqual({ verdict: "build-failed", detail: "pnpm build output" });
  });
});

describe("per-arm copy", () => {
  it("copies the prepared base with its history into a new dir", async () => {
    const preparedRoot = join(root, "prepared");
    mkdirSync(preparedRoot);
    await prepareBase({ baseDir: join(preparedRoot, "case-1"), treeDir, mergeSha: MERGE, exec: recordingExec().exec });
    const dest = join(root, "jobs", "ws");
    mkdirSync(join(root, "jobs"));

    await copyPreparedBase("case-1", dest, { preparedRoot });

    expect(readFileSync(join(dest, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(dest, ".git"))).toBe(true);
  });

  it("refuses to copy over an existing workspace", async () => {
    const preparedRoot = join(root, "prepared");
    mkdirSync(join(preparedRoot, "case-1"), { recursive: true });
    mkdirSync(join(root, "ws"));

    await expect(copyPreparedBase("case-1", join(root, "ws"), { preparedRoot })).rejects.toThrow(/refusing to copy over/);
  });
});
