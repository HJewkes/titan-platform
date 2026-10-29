import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fixtureEnv } from "@titan-design/test-kit/git";
import { loadFileFirstSeen } from "./first-seen.js";
import { discoveryEnv } from "./git.js";
import { loadChurnEntries } from "./log.js";
import { daysAgo, makeTestRepo, type TestRepo } from "./test-repo.js";

describe("loadChurnEntries on a real repository", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await makeTestRepo();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo.cleanup();
  });

  it("reads author email, committer time, and numstat per file", async () => {
    await repo.write("src/a.ts", "one\ntwo\n");
    repo.commit("init", { author: "alice", date: daysAgo(3) });
    const [e] = loadChurnEntries({ repoRoot: repo.dir, windowDays: 30 })!;
    expect(e).toMatchObject({ author: "alice@example.com", filePath: "src/a.ts", added: 2, deleted: 0 });
    expect(e!.epoch).toBeGreaterThan(0);
  });

  it("drops commits older than the window and keeps all of them for lifetime", async () => {
    repo.history([
      { message: "old", date: daysAgo(400), files: { "a.ts": "1\n" } },
      { message: "new", date: daysAgo(2), files: { "a.ts": "1\n2\n" } },
    ]);
    expect(loadChurnEntries({ repoRoot: repo.dir, windowDays: 30 })).toHaveLength(1);
    expect(loadChurnEntries({ repoRoot: repo.dir, windowDays: "lifetime" })).toHaveLength(2);
  });

  it("rebases paths onto a subdirectory root and drops files outside it", async () => {
    await repo.write("packages/foo/inside.ts", "1\n");
    await repo.write("outside.ts", "1\n");
    repo.commit("init", { date: daysAgo(1) });
    const entries = loadChurnEntries({ repoRoot: path.join(repo.dir, "packages"), windowDays: 30 })!;
    expect(entries.map((e) => e.filePath)).toEqual(["foo/inside.ts"]);
  });

  it("attributes a rename-with-edit to the new path", async () => {
    repo.history([
      { message: "init", date: daysAgo(2), files: { "src/old.ts": "v1\n" } },
      { message: "rename", date: daysAgo(1), files: { "src/old.ts": null, "src/new.ts": "v1\nv2\n" } },
    ]);
    const paths = loadChurnEntries({ repoRoot: repo.dir, windowDays: 30 })!.map((e) => e.filePath);
    expect(paths).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("ignores an inherited GIT_DIR that points at another repository", async () => {
    await repo.write("a.ts", "1\n");
    repo.commit("init", { date: daysAgo(1) });
    const other = await makeTestRepo();
    try {
      vi.stubEnv("GIT_DIR", path.join(other.dir, ".git"));
      expect(discoveryEnv().GIT_DIR).toBeUndefined();
      expect(loadChurnEntries({ repoRoot: repo.dir, windowDays: 30 })).toHaveLength(1);
    } finally {
      await other.cleanup();
    }
  });

  it("works on a shallow clone with the history it has", async () => {
    repo.history([1, 2, 3].map((n) => ({ message: `c${n}`, date: daysAgo(10 - n), files: { "a.ts": "x\n".repeat(n) } })));
    const clone = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo.dir}`, clone], { env: fixtureEnv() });
      expect(loadChurnEntries({ repoRoot: clone, windowDays: 30 })).toHaveLength(1);
      expect(loadFileFirstSeen({ repoRoot: clone })?.has("a.ts")).toBe(true);
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }
  });
});

describe("history outside git", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-nogit-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null for a directory that is not a git repository", () => {
    vi.stubEnv("GIT_CEILING_DIRECTORIES", path.dirname(dir));
    expect(loadChurnEntries({ repoRoot: dir })).toBeNull();
    expect(loadFileFirstSeen({ repoRoot: dir })).toBeNull();
  });

  it("returns null when the git binary is missing", () => {
    vi.stubEnv("PATH", dir);
    expect(loadChurnEntries({ repoRoot: process.cwd() })).toBeNull();
    expect(loadFileFirstSeen({ repoRoot: process.cwd() })).toBeNull();
  });
});

describe("loadFileFirstSeen", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await makeTestRepo();
  });

  afterEach(() => repo.cleanup());

  it("records each path's earliest commit time, filtered to known paths", async () => {
    repo.history([
      { message: "a", date: "2024-01-01T00:00:00Z", files: { "a.ts": "1\n" } },
      { message: "b", date: "2024-02-01T00:00:00Z", files: { "a.ts": "1\n2\n", "b.ts": "1\n" } },
    ]);
    const all = loadFileFirstSeen({ repoRoot: repo.dir })!;
    expect(all.get("a.ts")).toBe(Date.parse("2024-01-01T00:00:00Z") / 1000);
    expect(all.get("b.ts")).toBe(Date.parse("2024-02-01T00:00:00Z") / 1000);
    expect([...loadFileFirstSeen({ repoRoot: repo.dir, knownPaths: new Set(["b.ts"]) })!.keys()]).toEqual(["b.ts"]);
  });
});
