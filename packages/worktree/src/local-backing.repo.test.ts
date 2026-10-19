import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedRepoWithOrigin } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";
import {
  parkWorktree,
  type ParkOptions,
  type ParkLocalBackingCandidate,
  type ParkLocalBackingReader,
} from "./park.js";

const roots: string[] = [];
const allocated = "agent-chat/worker-a";
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: fixtureEnv(),
  }).trim();
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function commit(tree: string, name: string): string {
  fs.writeFileSync(path.join(tree, name), name);
  git(tree, "add", "--", name);
  git(tree, "commit", "-qm", name);
  return git(tree, "rev-parse", "HEAD");
}
function fixture(side = false, backed = false) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "local-backing-"))
  );
  roots.push(root);
  const repo = path.join(root, "repo"),
    origin = path.join(root, "origin"),
    tree = path.join(root, "tree");
  fs.mkdirSync(repo);
  fs.mkdirSync(origin);
  seedRepoWithOrigin(repo, origin);
  git(repo, "worktree", "add", "-qb", allocated, tree);
  if (side) git(tree, "switch", "-qc", "side");
  const head = commit(tree, "feature.ts");
  const branch = side ? "side" : allocated;
  git(tree, "push", "-q", "origin", "HEAD:refs/heads/" + branch);
  if (!backed) {
    git(origin, "update-ref", "-d", "refs/heads/" + branch, head);
    git(repo, "fetch", "-q", "--prune", "origin");
  }
  return {
    repo,
    tree,
    head,
    branch,
    target: { gitRoot: repo, worktree: tree, branch: allocated },
  };
}
type Fixture = ReturnType<typeof fixture>;
const options = (
  reader: ParkLocalBackingReader
): ParkOptions & {
  allowOriginHeadAncestor: true;
  localBackingCandidates: ParkLocalBackingReader;
} => ({
  allowOriginHeadAncestor: true,
  allowDefaultBranchAncestor: true,
  localBackingCandidates: reader,
});
const candidate = (
  f: Fixture,
  ref = "opaque-ref"
): readonly ParkLocalBackingCandidate[] => [{ oid: f.head, ref }];
function retained(f: Fixture) {
  expect(fs.readFileSync(path.join(f.tree, "feature.ts"), "utf8")).toBe(
    "feature.ts"
  );
  expect(git(f.repo, "rev-parse", f.branch)).toBe(f.head);
}
// Intentionally malformed runtime result, without weakening the public callback type.
function invalidReader(value: unknown): ParkLocalBackingReader {
  const holder: { read: ParkLocalBackingReader } = { read: async () => [] };
  Reflect.set(holder, "read", () => Promise.resolve(value));
  return holder.read;
}

describe("lazy local backing candidates", () => {
  it.each([false, true])(
    "keeps actual branch and correlates a selected local proof (side=%s)",
    async (side) => {
      const f = fixture(side),
        allocatedBefore = git(f.repo, "rev-parse", allocated);
      const calls: unknown[] = [];
      const result = await parkWorktree(
        f.target,
        undefined,
        options(async (observation) => {
          calls.push({ ...observation });
          expect(Object.isFrozen(observation)).toBe(true);
          expect(Reflect.set(observation, "head", "0".repeat(40))).toBe(false);
          return candidate(f);
        })
      );
      expect(result).toEqual({
        ok: true,
        head: f.head,
        branch: f.branch,
        backingRef: "opaque-ref",
      });
      expect(calls).toEqual([
        { branch: f.branch, head: f.head, worktree: f.tree },
      ]);
      expect(fs.existsSync(f.tree)).toBe(false);
      expect(git(f.repo, "rev-parse", f.branch)).toBe(f.head);
      expect(git(f.repo, "rev-parse", allocated)).toBe(allocatedBefore);
    }
  );
  it("accepts a local containing descendant and returns the first usable correlation", async () => {
    const f = fixture();
    const oid = git(
      f.tree,
      "commit-tree",
      git(f.tree, "rev-parse", "HEAD^{tree}"),
      "-p",
      f.head,
      "-m",
      "owned candidate"
    );
    const values = [
      { oid: "f".repeat(40), ref: "missing" },
      { oid, ref: "selected" },
      { oid, ref: "later" },
    ];
    const result = await parkWorktree(
      f.target,
      undefined,
      options(async () => values)
    );
    expect(result).toEqual({
      ok: true,
      head: f.head,
      branch: f.branch,
      backingRef: "selected",
    });
    expect(Object.isFrozen(values)).toBe(false);
    expect(Object.isFrozen(values[1])).toBe(false);
  });
  it.each(["tracked", "no-origin", "dirty", "detached"] as const)(
    "keeps the reader lazy for %s",
    async (kind) => {
      const f = fixture(false, kind === "tracked");
      let calls = 0;
      if (kind === "no-origin") git(f.repo, "remote", "remove", "origin");
      if (kind === "dirty")
        fs.writeFileSync(path.join(f.tree, "note.txt"), "owned note");
      if (kind === "detached") git(f.tree, "switch", "-q", "--detach");
      const result = await parkWorktree(
        f.target,
        undefined,
        options(async () => {
          calls++;
          return candidate(f);
        })
      );
      expect(calls).toBe(0);
      expect(result.ok).toBe(kind === "tracked" || kind === "no-origin");
      expect(Object.hasOwn(result, "backingRef")).toBe(false);
      if (!result.ok) retained(f);
    }
  );
  it.each([false, undefined])(
    "requires strict origin opt-in (%s)",
    async (flag) => {
      const f = fixture();
      let calls = 0;
      const value: ParkOptions = {
        localBackingCandidates: async () => {
          calls++;
          return candidate(f);
        },
      };
      if (flag !== undefined) value.allowOriginHeadAncestor = flag;
      const result = await parkWorktree(f.target, undefined, value);
      expect(result.ok).toBe(false);
      expect(calls).toBe(0);
      retained(f);
    }
  );
  it.each([
    "empty",
    "reject",
    "throw",
    "missing",
    "after",
    "blob",
    "tag",
    "short",
    "option",
    "sparse",
    "partial",
    "getter",
  ] as const)(
    "rejects %s candidates after actually invoking the reader",
    async (kind) => {
      const f = fixture();
      let value: unknown = [];
      if (kind === "missing") value = [{ oid: "f".repeat(40), ref: "missing" }];
      if (kind === "after") {
        const old = f.head;
        f.head = commit(f.tree, "later.ts");
        value = [{ oid: old, ref: "old" }];
      }
      if (kind === "blob")
        value = [
          { oid: git(f.tree, "rev-parse", "HEAD:feature.ts"), ref: "blob" },
        ];
      if (kind === "tag") {
        git(f.tree, "tag", "-am", "owned tag", "owned-tag", f.head);
        value = [{ oid: git(f.tree, "rev-parse", "owned-tag"), ref: "tag" }];
      }
      if (kind === "short")
        value = [{ oid: f.head.slice(0, 12), ref: "short" }];
      if (kind === "option") value = [{ oid: "--help", ref: "option" }];
      if (kind === "sparse") value = new Array(1);
      if (kind === "partial") value = [...candidate(f), null];
      if (kind === "getter")
        value = [
          {
            get oid(): string {
              throw new Error("owned getter");
            },
            ref: "getter",
          },
        ];
      let calls = 0;
      const read = invalidReader(value);
      const result = await parkWorktree(
        f.target,
        undefined,
        options((observation) => {
          calls++;
          if (kind === "throw") throw new Error("owned sync failure");
          if (kind === "reject")
            return Promise.reject(new Error("owned async failure"));
          return read(observation);
        })
      );
      expect(calls).toBe(1);
      expect(result.ok).toBe(false);
      retained(f);
      expect(Object.hasOwn(result, "backingRef")).toBe(false);
    }
  );
  it.each(["file", "head", "branch", "reject-head"] as const)(
    "retains actual %s movement during the reader",
    async (kind) => {
      const f = fixture(),
        captured = f.head;
      let moved: string | undefined,
        calls = 0;
      const result = await parkWorktree(
        f.target,
        undefined,
        options(async (observation) => {
          calls++;
          expect(observation.head).toBe(captured);
          await Promise.resolve();
          if (kind === "file")
            fs.writeFileSync(path.join(f.tree, "note.txt"), "owned late note");
          else if (kind === "branch") git(f.tree, "switch", "-qc", "late-side");
          else moved = commit(f.tree, "note.txt");
          if (kind === "reject-head")
            throw new Error("owned rejection after change");
          return [{ oid: moved ?? captured, ref: "backs-even-new-head" }];
        })
      );
      expect(calls).toBe(1);
      expect(result.ok).toBe(false);
      expect(fs.existsSync(f.tree)).toBe(true);
      if (moved) expect(git(f.tree, "rev-parse", "HEAD")).toBe(moved);
      if (kind === "branch")
        expect(git(f.tree, "symbolic-ref", "--short", "HEAD")).toBe(
          "late-side"
        );
      if (kind === "file")
        expect(fs.readFileSync(path.join(f.tree, "note.txt"), "utf8")).toBe(
          "owned late note"
        );
    }
  );
  it("rechecks a committed HEAD change made by the caller before removal", async () => {
    const f = fixture();
    let calls = 0,
      moved: string | undefined;
    const result = await parkWorktree(
      f.target,
      () => {
        calls++;
        moved = commit(f.tree, "late.txt");
        return undefined;
      },
      options(async () => candidate(f))
    );
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(f.tree)).toBe(true);
    expect(git(f.tree, "rev-parse", "HEAD")).toBe(moved);
  });

  it("retains a real ignored note appearing after the candidate ancestry probe", async () => {
    const f = fixture();
    // The cache-named note is deliberately protected; no policy waives it.
    fs.writeFileSync(path.join(f.tree, ".gitignore"), "late-note.txt\n");
    git(f.tree, "add", ".gitignore");
    git(f.tree, "commit", "-qm", "owned ignore rule");
    f.head = git(f.tree, "rev-parse", "HEAD");
    const bin = path.join(f.tree, "..", "controlled-bin"),
      marker = path.join(bin, "entered");
    fs.mkdirSync(bin);
    const q = (value: string): string =>
      "'" + value.replaceAll("'", "'\\''") + "'";
    const body = [
      "#!/bin/sh",
      'if [ "$PWD" = ' +
        q(f.tree) +
        ' ] && [ "$1" = merge-base ] && [ "$2" = --is-ancestor ] && [ "$3" = ' +
        q(f.head) +
        ' ] && [ "$4" = ' +
        q(f.head) +
        " ]; then",
      ' /usr/bin/git "$@"',
      " status=$?",
      ' if [ "$status" = 0 ] && [ ! -e ' + q(marker) + " ]; then",
      "  printf entered > " + q(marker),
      "  printf 'owned ignored late note' > " +
        q(path.join(f.tree, "late-note.txt")),
      " fi",
      ' exit "$status"',
      "fi",
      'exec /usr/bin/git "$@"',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(bin, "git"), body, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 97\n", {
      mode: 0o700,
    });
    vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
    const result = await parkWorktree(
      f.target,
      undefined,
      options(async () => candidate(f))
    );
    expect(fs.readFileSync(marker, "utf8")).toBe("entered");
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(f.tree, "late-note.txt"), "utf8")).toBe(
      "owned ignored late note"
    );
    retained(f);
  });
});
