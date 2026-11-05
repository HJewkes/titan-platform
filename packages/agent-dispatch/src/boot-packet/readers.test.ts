import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execSafe, minimalEnv } from "../exec.js";
import { nodeBootReaders } from "./readers.js";

const GIT_BIN = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find((p) => existsSync(p)) ?? "";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-boot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(bin: string, ...args: string[]): void {
  const env = { ...minimalEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" };
  const r = execSafe(bin, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], env, 10_000, dir);
  if (r.status !== 0) throw new Error(r.stderr);
}

describe.runIf(GIT_BIN !== "")("nodeBootReaders", () => {
  it("reads base and head commits, the commits ahead and the base commits naming the task", () => {
    const bin = GIT_BIN;
    git(bin, "init", "-q", "-b", "main");
    git(bin, "commit", "-q", "--allow-empty", "-m", "Land the header (WG-7)");
    git(bin, "branch", "base");
    git(bin, "commit", "-q", "--allow-empty", "-m", "Start the parser");
    const now = (): Date => new Date("2030-01-02T03:04:05Z");

    const readers = nodeBootReaders({ repoRoot: dir, gitBin: bin, baseRef: "base", readTask: () => null, now });
    const state = readers.gitState("WG-7");

    expect(state?.capturedAt).toBe("2030-01-02T03:04:05.000Z");
    expect(state?.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state?.headSha).not.toBe(state?.baseSha);
    expect(state?.ahead).toHaveLength(1);
    expect(state?.ahead[0]).toContain("Start the parser");
    expect(state?.landed[0]).toContain("(WG-7)");
    expect(state?.openPrs).toBeUndefined();
  });

  it("gives no git state outside a repository, and null for a missing file", () => {
    writeFileSync(join(dir, "a.txt"), "hello");

    const readers = nodeBootReaders({ repoRoot: dir, gitBin: GIT_BIN, readTask: () => null });

    expect(readers.gitState("WG-7")).toBeNull();
    expect(readers.readFile("a.txt")).toBe("hello");
    expect(readers.readFile("missing.txt")).toBeNull();
    expect(readers.exists("a.txt")).toBe(true);
  });
});
