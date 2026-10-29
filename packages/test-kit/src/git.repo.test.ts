import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureEnv, gitIn, removeTemplates, seedRepo, seedRepoWithOrigin, templateDirectory, withHistory, type HistoryCommit } from "./git.js";

const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-fixture-test-"));
  tmpdirs.push(dir);
  return dir;
}

describe("template cleanup", () => {
  it("deletes the template directory, and the next seed builds a fresh one", () => {
    seedRepo(emptyDir());
    const first = templateDirectory();
    expect(first && fs.existsSync(first)).toBe(true);

    removeTemplates();

    expect(fs.existsSync(first!)).toBe(false);
    const repo = emptyDir();
    seedRepo(repo);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("seed\n");
    expect(templateDirectory()).not.toBe(first);
  });
});

describe("seeded repositories", () => {
  it("gives each copy the seed commit, an empty hooks directory and no auto-maintenance", () => {
    const repo = emptyDir();

    seedRepo(repo, { "src/a.txt": "a\n" });

    const git = gitIn(repo);
    expect(git("ls-tree", "-r", "--name-only", "main")).toBe("src/a.txt");
    expect(fs.readdirSync(path.join(repo, ".git", "hooks"))).toEqual([]);
    expect(git("config", "maintenance.auto")).toBe("false");
    expect(git("config", "gc.auto")).toBe("0");
  });

  it("leaves main unborn for an empty seed", () => {
    const repo = emptyDir();

    seedRepo(repo, {});

    expect(gitIn(repo)("for-each-ref")).toBe("");
  });

  it("points the copy at its own origin, which already holds the seed commit", () => {
    const repo = emptyDir();
    const origin = emptyDir();

    seedRepoWithOrigin(repo, origin);

    const git = gitIn(repo);
    expect(git("remote", "get-url", "origin")).toBe(origin);
    expect(gitIn(origin)("rev-parse", "main")).toBe(git("rev-parse", "main"));
  });
});

describe("withHistory", () => {
  it("writes the commits in order, with the same shas on every run, and checks out the last branch", () => {
    const history: HistoryCommit[] = [
      { files: { "a.txt": "a0\n" }, message: "first" },
      { files: { "b.txt": "b0\n" } },
      { branch: "feature", from: "main", files: { "a.txt": "a1\n", "b.txt": null } },
    ];
    const [repo, again] = [emptyDir(), emptyDir()];
    seedRepo(repo, {});
    seedRepo(again, {});

    const shas = withHistory(repo, history);

    const git = gitIn(repo);
    expect(shas).toEqual(withHistory(again, history));
    expect(git("rev-list", "--reverse", "main", "feature")).toBe(shas.join("\n"));
    expect(git("log", "--format=%s %ct", "main")).toBe(`commit 2 1700000002\nfirst 1700000001`);
    expect(git("branch", "--show-current")).toBe("feature");
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a1\n");
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
  });

  it("continues an existing branch from its tip", () => {
    const repo = emptyDir();
    seedRepo(repo);
    const seed = gitIn(repo)("rev-parse", "main");

    const [next] = withHistory(repo, [{ files: { "c.txt": "c\n" } }]);

    expect(gitIn(repo)("rev-parse", `${next}^`)).toBe(seed);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("seed\n");
  });
});

describe("fixtureEnv", () => {
  it("drops injected config entries and pins the identity", () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");

    const env = fixtureEnv();

    vi.unstubAllEnvs();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_COMMITTER_EMAIL).toBe("test@example.com");
  });
});
