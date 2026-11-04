import fs from "node:fs";
import path from "node:path";
import { inspectForRelease as packageInspect, parkWorktree } from "@titan-design/worktree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, makeRepo, removeTempDirs, tempDir, withRemote } from "./fixtures/git-repo.js";
import { dispatchIgnoredFiles, unsavedWork } from "./index.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(removeTempDirs);

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const branch = "agent-chat/policy";

/** A clean tree on its own branch; `ignored` lines go in the shared exclude file. */
function treeIgnoring(...ignored: string[]) {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), `\n${ignored.join("\n")}\n`);
  const tree = path.join(tempDir("iso-tree-"), "tree");
  git(["worktree", "add", "-qb", branch, tree], repo);
  return { repo, tree };
}

function put(tree: string, file: string, text = "x\n"): void {
  const at = path.join(tree, file);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
}

const commitAll = (tree: string): void => {
  git(["add", "."], tree);
  git(["commit", "-qm", "commit"], tree);
};

/** The regenerable directories the package names in its own refusal, so a new entry there reaches this test. */
async function packageRegenerableDirs(): Promise<string[]> {
  const { repo, tree } = treeIgnoring("kept.txt");
  put(tree, "kept.txt");
  const safety = await packageInspect(repo, tree, branch, "HEAD");
  const detail = safety.checked.find((check) => check.name === "dirty")?.detail ?? "";
  const listed = /only ignored (.+) and a top-level \.claude are removed/.exec(detail)?.[1];
  if (listed === undefined) throw new Error(`package refusal changed its wording: ${detail}`);
  return listed.split(", ");
}

describe("the dispatch policy against the package default", () => {
  it("is never stricter than the package about anything the package lets go", async () => {
    const dirs = await packageRegenerableDirs();
    const entries = [".claude/settings.json", ...dirs.flatMap((d) => [`${d}/a.txt`, `packages/a/${d}/a.txt`])];
    const { repo, tree } = treeIgnoring(...dirs.map((d) => `${d}/`), ".claude/");
    // Tracked, so git lists the nested outputs instead of collapsing `packages/` into one entry.
    put(tree, "packages/a/index.ts");
    commitAll(tree);
    for (const entry of entries) put(tree, entry);

    const packageSafety = await packageInspect(repo, tree, branch, "HEAD");

    expect(dirs).toEqual(expect.arrayContaining(["node_modules", "dist", "coverage", ".turbo"]));
    expect(packageSafety.dirty).toBe(false);
    expect(await unsavedWork(tree, "release")).toBeUndefined();
  });

  it.each([
    [".api-extractor-temp/a.json", ".api-extractor-temp/"],
    ["packages/a/.eslintcache", ".eslintcache"],
    ["packages/a/tsconfig.tsbuildinfo", "*.tsbuildinfo"],
  ])("also lets go of %s, which the package would hold", async (file, pattern) => {
    const { repo, tree } = treeIgnoring(pattern);
    put(tree, file);

    expect((await packageInspect(repo, tree, branch, "HEAD")).dirty).toBe(true);
    expect(await unsavedWork(tree, "release")).toBeUndefined();
  });
});

describe("files the policy keeps", () => {
  it("reports tracked or untracked work as changes, past any ignored-file reasoning", async () => {
    const { tree } = treeIgnoring();
    put(tree, "scratch.ts");

    expect(await unsavedWork(tree, "release")).toEqual({
      kind: "changes",
      detail: `uncommitted or untracked changes in ${tree}`,
    });
  });

  it("sees an untracked file that status.showUntrackedFiles=no hides", async () => {
    const { repo, tree } = treeIgnoring();
    git(["config", "status.showUntrackedFiles", "no"], repo);
    put(tree, "scratch.ts");

    expect((await unsavedWork(tree, "release"))?.kind).toBe("changes");
  });

  it("counts a tree git cannot read as unsaved", async () => {
    const dir = tempDir("iso-not-git-");

    expect(await unsavedWork(dir, "release")).toEqual({
      kind: "other",
      detail: `could not read git status in ${dir}`,
    });
  });

  it("names the action and the kept file in its refusal", async () => {
    const { tree } = treeIgnoring("kept.txt");
    put(tree, "kept.txt");

    const unsaved = await unsavedWork(tree, "release");

    expect(unsaved?.kind).toBe("other");
    expect(unsaved?.detail).toContain("(kept.txt)");
    expect(unsaved?.detail).toContain("release removes only ignored node_modules");
  });

  it("does not take a directory named like a build output for one", async () => {
    const { tree } = treeIgnoring("notes.tsbuildinfo/");
    put(tree, "notes.tsbuildinfo/kept.md");

    expect((await unsavedWork(tree, "release"))?.detail).toContain("notes.tsbuildinfo/kept.md");
  });

  it("keeps a nested .claude, since re-attach restores only the top-level one", async () => {
    const { tree } = treeIgnoring(".claude/");
    put(tree, "packages/a/.claude/kept.json");

    expect((await unsavedWork(tree, "release"))?.detail).toContain("packages/a/.claude/kept.json");
  });

  it("judges each file of a wholly ignored directory alone", async () => {
    const { tree } = treeIgnoring("scratch/");
    put(tree, "scratch/dist/out.js");
    expect(await unsavedWork(tree, "release")).toBeUndefined();

    put(tree, "scratch/kept.md");
    const detail = (await unsavedWork(tree, "release"))?.detail;

    expect(detail).toContain("(scratch/kept.md)");
  });
});

describe("a declared generated file (CC-1582)", () => {
  const declare = (tree: string, text: string): void => put(tree, ".agent-chat/generated", text);

  it("waives an exact path a committed declaration lists", async () => {
    const { tree } = treeIgnoring("site/guide.md", "site/kept.md");
    declare(tree, "# built by docs\nsite/guide.md\n");
    commitAll(tree);
    put(tree, "site/guide.md");
    expect(await unsavedWork(tree, "release")).toBeUndefined();

    put(tree, "site/kept.md");

    expect((await unsavedWork(tree, "release"))?.detail).toContain("(site/kept.md)");
  });

  it("waives nothing from an uncommitted declaration", async () => {
    const { tree } = treeIgnoring("guide.md", ".agent-chat/");
    declare(tree, "guide.md\n");
    put(tree, "guide.md");

    expect((await unsavedWork(tree, "release"))?.detail).toContain("guide.md");
  });

  it("does not take a directory line as a waiver", async () => {
    const { tree } = treeIgnoring("site/");
    declare(tree, "site/\n");
    commitAll(tree);
    put(tree, "site/guide.md");

    expect((await unsavedWork(tree, "release"))?.detail).toContain("site/guide.md");
  });
});

describe("a codewatch index (CC-1163)", () => {
  function graphDb(tree: string, sql: string, at = ".codewatch/graph.db"): void {
    put(tree, at, "");
    const db = new DatabaseSync(path.join(tree, at));
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  }
  const INDEX = "CREATE TABLE snapshot(id INTEGER PRIMARY KEY); INSERT INTO snapshot VALUES(1);";

  it("lets go of an index-only top-level graph db", async () => {
    const { tree } = treeIgnoring(".codewatch/");
    graphDb(tree, `${INDEX} CREATE TABLE verdict(value TEXT); CREATE TABLE node(id TEXT); INSERT INTO node VALUES('n');`);

    expect(await unsavedWork(tree, "release")).toBeUndefined();
  });

  it.each(["verdict", "blob_cache", "unfamiliar"])("keeps a graph db with rows in %s", async (table) => {
    const { tree } = treeIgnoring(".codewatch/");
    graphDb(tree, `${INDEX} CREATE TABLE ${table}(value TEXT); INSERT INTO ${table} VALUES('paid');`);

    expect((await unsavedWork(tree, "release"))?.detail).toContain(".codewatch/graph.db");
  });

  it("keeps a sqlite file that is no code-graph db", async () => {
    const { tree } = treeIgnoring(".codewatch/");
    graphDb(tree, "CREATE TABLE other(value TEXT);");

    expect((await unsavedWork(tree, "release"))?.detail).toContain(".codewatch/graph.db");
  });

  it("keeps a file it cannot read as sqlite", async () => {
    const { tree } = treeIgnoring(".codewatch/");
    put(tree, ".codewatch/graph.db", "not a database");

    expect((await unsavedWork(tree, "release"))?.detail).toContain(".codewatch/graph.db");
  });

  it("keeps a nested copy, since codewatch writes its index only at the toplevel", async () => {
    const { tree } = treeIgnoring(".codewatch/");
    graphDb(tree, INDEX, "packages/a/.codewatch/graph.db");

    expect((await unsavedWork(tree, "release"))?.detail).toContain("packages/a/.codewatch/graph.db");
  });

  describe.each(["proof", "caller"] as const)("through park, paid rows at the %s boundary", (phase) => {
    function parkable() {
      const repo = makeRepo();
      fs.writeFileSync(path.join(repo, ".gitignore"), ".codewatch/\n");
      git(["add", "."], repo);
      git(["commit", "-qm", "ignore"], repo);
      withRemote(repo);
      const tree = path.join(tempDir("iso-park-"), "tree");
      git(["worktree", "add", "-qb", branch, tree], repo);
      put(tree, "feature.txt", "committed work\n");
      commitAll(tree);
      graphDb(tree, `${INDEX} CREATE TABLE verdict(value TEXT);`);
      return { repo, tree, head: git(["rev-parse", "HEAD"], tree) };
    }

    const paidRows = (tree: string): unknown => {
      const db = new DatabaseSync(path.join(tree, ".codewatch/graph.db"));
      try {
        return db.prepare("SELECT value FROM verdict").all();
      } finally {
        db.close();
      }
    };

    const insertPaid = (tree: string): void => {
      const db = new DatabaseSync(path.join(tree, ".codewatch/graph.db"));
      try {
        db.exec("INSERT INTO verdict VALUES('paid');");
      } finally {
        db.close();
      }
    };

    const park = (f: ReturnType<typeof parkable>, late: () => void) =>
      parkWorktree(
        { gitRoot: f.repo, worktree: f.tree, branch },
        () => {
          if (phase === "caller") late();
          return undefined;
        },
        {
          allowOriginHeadAncestor: true,
          allowDefaultBranchAncestor: true,
          ignoredFiles: dispatchIgnoredFiles,
          localBackingCandidates: async () => {
            if (phase === "proof") late();
            return [{ oid: f.head, ref: "7" }];
          },
        },
      );

    it("keeps a row written during the park, and the tree", async () => {
      const f = parkable();

      const result = await park(f, () => insertPaid(f.tree));

      expect(result).toMatchObject({ ok: false });
      expect(paidRows(f.tree)).toEqual([{ value: "paid" }]);
    });

    it("parks the same tree when no paid row arrives, keeping the branch", async () => {
      const f = parkable();

      const result = await park(f, () => undefined);

      expect(result).toMatchObject({ ok: true, head: f.head });
      expect(fs.existsSync(f.tree)).toBe(false);
      expect(git(["rev-parse", branch], f.repo)).toBe(f.head);
    });
  });
});
