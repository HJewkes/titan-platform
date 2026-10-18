import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { seedRepoWithOrigin } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";
import { parkWorktree } from "./park.js";

const roots: string[] = [];
const allocated = "agent-chat/worker";
const actual = "actual/pr-head";
const alternative = "published/alternative";
const note = "harmless owned tracked work\n";
const git = (cwd: string, args: string[]): string =>
  execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: "pipe", env: fixtureEnv() }).trim();
const maybe = (cwd: string, args: string[]): string | null => {
  try { return git(cwd, args); } catch { return null; }
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Kind = "own" | "other-alternative" | "alternative" | "deleted" | "replaced" | "missing" | "tracked";
function fixture(kind: Kind) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "origin-park-")));
  roots.push(root);
  const repo = path.join(root, "repo"); const origin = path.join(root, "origin");
  fs.mkdirSync(repo); fs.mkdirSync(origin); seedRepoWithOrigin(repo, origin);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const tree = path.join(repo, ".worktrees", "worker");
  git(repo, ["worktree", "add", "-qb", allocated, tree]);
  fs.writeFileSync(path.join(tree, "owned.txt"), note);
  git(tree, ["add", "."]); git(tree, ["commit", "-qm", "owned work"]);
  const head = git(tree, ["rev-parse", "HEAD"]);
  let remoteTip = head;
  if (kind === "own") {
    git(tree, ["switch", "-qc", actual]);
    git(tree, ["push", "-q", "origin", "HEAD:refs/heads/" + actual]);
    expect(git(repo, ["rev-parse", "origin/" + actual])).toBe(head);
  } else if (kind === "tracked") {
    git(tree, ["push", "-q", "origin", "HEAD:refs/heads/" + allocated]);
  } else if (kind === "missing") {
    const writer = path.join(root, "writer"); fs.mkdirSync(writer);
    git(writer, ["init", "-q", "-b", "writer"]);
    for (const [key, value] of [
      ["user.email", "test@example.com"], ["user.name", "Test"],
      ["commit.gpgsign", "false"], ["gc.auto", "0"], ["maintenance.auto", "false"],
    ] as const) git(writer, ["config", key, value]);
    git(writer, ["fetch", "-q", repo, allocated]);
    git(writer, ["switch", "-qc", "writer-head", "FETCH_HEAD"]);
    fs.writeFileSync(path.join(writer, "writer.txt"), "owned descendant\n");
    git(writer, ["add", "."]); git(writer, ["commit", "-qm", "owned descendant"]);
    remoteTip = git(writer, ["rev-parse", "HEAD"]);
    git(writer, ["push", "-q", origin, "HEAD:refs/heads/" + alternative]);
    expect(maybe(repo, ["cat-file", "-e", remoteTip + "^{commit}"])).toBeNull();
    expect(git(origin, ["merge-base", "--is-ancestor", head, remoteTip])).toBe("");
  } else {
    git(tree, ["push", "-q", "origin", "HEAD:refs/heads/" + alternative]);
    expect(git(repo, ["rev-parse", "origin/" + alternative])).toBe(head);
    if (kind === "other-alternative") git(tree, ["switch", "-qc", actual]);
    if (kind === "deleted") git(origin, ["update-ref", "-d", "refs/heads/" + alternative, head]);
    if (kind === "replaced") {
      git(origin, ["update-ref", "refs/heads/" + alternative, base, head]); remoteTip = base;
    }
  }
  expect(git(tree, ["status", "--porcelain", "-uall"])).toBe("");
  return { root, repo, origin, tree, base, head, remoteTip,
    target: { gitRoot: repo, worktree: tree, branch: allocated } };
}
function retained(f: ReturnType<typeof fixture>) {
  expect(fs.readFileSync(path.join(f.tree, "owned.txt"), "utf8")).toBe(note);
  expect(git(f.repo, ["rev-parse", allocated])).toBe(f.head);
  if (maybe(f.repo, ["rev-parse", "--verify", actual]) !== null)
    expect(git(f.repo, ["rev-parse", actual])).toBe(f.head);
}

it.each(["own", "other-alternative", "alternative"] as const)(
  "explicit origin-head proof parks actual branch for %s",
  async kind => {
    const f = fixture(kind);
    const result = await parkWorktree(f.target, () => undefined, {
      allowOriginHeadAncestor: true, allowDefaultBranchAncestor: true, fetchTimeoutMs: 30_000,
    });
    expect(result).toEqual({
      ok: true, head: f.head, branch: kind === "alternative" ? allocated : actual,
      ...(kind === "own" ? {} : { containedIn: alternative }),
    });
    expect(fs.existsSync(f.tree)).toBe(false);
    expect(git(f.repo, ["rev-parse", allocated])).toBe(f.head);
    if (kind !== "alternative") expect(git(f.repo, ["rev-parse", actual])).toBe(f.head);
  }
);
it.each(["deleted", "replaced", "missing"] as const)(
  "origin-head proof retains data for %s server evidence",
  async kind => {
    const f = fixture(kind);
    const result = await parkWorktree(f.target, () => undefined, {
      allowOriginHeadAncestor: true, allowDefaultBranchAncestor: true, fetchTimeoutMs: 30_000,
    });
    expect(result).toEqual({ ok: false, reason: allocated + " is not on origin; push it first" });
    retained(f);
    if (kind === "missing") expect(maybe(f.repo, ["cat-file", "-e", f.remoteTip + "^{commit}"])).toBeNull();
  }
);
it.each(["omitted", "false", "p02"] as const)(
  "default result remains exact for %s new-mode option",
  async kind => {
    const f = fixture("tracked");
    const options = kind === "false" ? { allowOriginHeadAncestor: false }
      : kind === "p02" ? { allowDefaultBranchAncestor: true } : {};
    expect(await parkWorktree(f.target, () => undefined, options)).toEqual({ ok: true, head: f.head });
  }
);
it("without opt-in keeps the existing other-branch refusal", async () => {
  const f = fixture("own");
  expect(await parkWorktree(f.target, () => undefined, { allowDefaultBranchAncestor: true })).toEqual({
    ok: false, reason: "HEAD in " + f.tree + " is on " + actual + ", not on " + allocated + "; check out " + allocated + " first",
  });
  retained(f);
});

function commandFixture(f: ReturnType<typeof fixture>, body: string) {
  const bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  const calls = path.join(f.root, "git-calls");
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), [
    "#!/bin/sh", "printf '%s\\n' \"$*\" >> " + quote(calls), body,
    'exec /usr/bin/git "$@"', "",
  ].join("\n"), { mode: 0o755 });
  vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
  return { calls, quote };
}
function change(f: ReturnType<typeof fixture>, kind: string) {
  if (kind === "branch") git(f.tree, ["switch", "-qc", "moved"]);
  else if (kind === "head") {
    fs.writeFileSync(path.join(f.tree, "late.txt"), "owned late commit\n");
    git(f.tree, ["add", "."]); git(f.tree, ["commit", "-qm", "owned late commit"]);
  } else if (kind === "detach") git(f.tree, ["checkout", "--detach", "-q"]);
  else if (kind === "untracked") fs.writeFileSync(path.join(f.tree, "late.txt"), "owned late note\n");
  else if (kind === "ignored") {
    fs.appendFileSync(path.join(f.repo, ".git", "info", "exclude"), "\nlate.txt\n");
    fs.writeFileSync(path.join(f.tree, "late.txt"), "owned ignored note\n");
  } else fs.writeFileSync(path.join(f.root, "fault"), kind);
}
it.each(["branch", "head", "detach", "untracked", "ignored", "status", "ls-files"])(
  "new proof refuses %s introduced during caller recheck",
  async kind => {
    const f = fixture("alternative");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    commandFixture(f, 'if [ -f ' + quote(path.join(f.root, "fault")) + ' ] && [ "$1" = ' + quote(kind) + ' ]; then exit 1; fi');
    const recheck = vi.fn(() => { change(f, kind); return undefined; });
    const result = await parkWorktree(f.target, recheck, { allowOriginHeadAncestor: true });
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(f.tree, "owned.txt"), "utf8")).toBe(note);
    expect(maybe(f.repo, ["rev-parse", "--verify", allocated])).not.toBeNull();
    if (kind === "head") expect(git(f.repo, ["rev-parse", allocated])).not.toBe(f.head);
    if (kind === "untracked" || kind === "ignored") expect(fs.readFileSync(path.join(f.tree, "late.txt"), "utf8")).toContain("owned");
  }
);
it.each(["branch", "head", "detach", "untracked", "ignored", "status", "ls-files"])(
  "new proof refuses %s introduced during asynchronous origin listing",
  async kind => {
    const f = fixture("alternative");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const fault = path.join(f.root, "fault");
    const action = kind === "branch" ? '/usr/bin/git -C ' + quote(f.tree) + ' switch -qc moved'
      : kind === "head" ? "printf '%s\\n' owned > " + quote(path.join(f.tree, "late.txt")) +
        "\n/usr/bin/git -C " + quote(f.tree) + " add ." +
        "\n/usr/bin/git -C " + quote(f.tree) + " commit -qm 'owned late commit'"
      : kind === "detach" ? '/usr/bin/git -C ' + quote(f.tree) + ' checkout --detach -q'
      : kind === "untracked" ? "printf '%s\\n' owned > " + quote(path.join(f.tree, "late.txt"))
      : kind === "ignored" ? "printf '%s\\n' late.txt >> " + quote(path.join(f.repo, ".git", "info", "exclude")) +
        "\nprintf '%s\\n' owned > " + quote(path.join(f.tree, "late.txt"))
      : "printf '%s\\n' active > " + quote(fault);
    const { calls } = commandFixture(f, [
      'if [ -f ' + quote(fault) + ' ] && [ "$1" = ' + quote(kind) + ' ]; then exit 1; fi',
      'if [ "$1" = ls-remote ] && [ "$2" = --heads ]; then',
      '  /usr/bin/git "$@"', action, '  exit 0', 'fi',
    ].join("\n"));
    const recheck = vi.fn(() => undefined);
    expect((await parkWorktree(f.target, recheck, { allowOriginHeadAncestor: true })).ok).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).toContain("ls-remote --heads origin");
    expect(recheck).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.tree, "owned.txt"), "utf8")).toBe(note);
    expect(maybe(f.repo, ["rev-parse", "--verify", allocated])).not.toBeNull();
    if (kind === "head") expect(git(f.repo, ["rev-parse", allocated])).not.toBe(f.head);
  }
);
it.each(["--help", "a".repeat(39), "g".repeat(40), "a".repeat(41), "g".repeat(64), "a".repeat(65)])(
  "never passes malformed listed object ID %s to ancestry Git",
  async sha => {
    const f = fixture("alternative");
    const output = path.join(f.root, "listed");
    fs.writeFileSync(output, sha + "\trefs/heads/proof\n");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const { calls } = commandFixture(f, 'if [ "$1" = ls-remote ] && [ "$2" = --heads ]; then cat ' + quote(output) + '; exit 0; fi');
    expect((await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true })).ok).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).not.toContain("merge-base");
    retained(f);
  }
);
it.each(["refs/tags/proof", "refs/heads/"])("rejects invalid listed ref prefix %s", async ref => {
  const f = fixture("alternative");
  const output = path.join(f.root, "listed"); fs.writeFileSync(output, f.head + "\t" + ref + "\n");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const { calls } = commandFixture(f, 'if [ "$1" = ls-remote ] && [ "$2" = --heads ]; then cat ' + quote(output) + '; exit 0; fi');
  expect((await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true })).ok).toBe(false);
  expect(fs.readFileSync(calls, "utf8")).not.toContain("merge-base");
  retained(f);
});
it.each([0, -1, NaN, Infinity, -Infinity])("refuses required fresh proof for invalid explicit budget %s", async fetchTimeoutMs => {
  const f = fixture("alternative"); const { calls } = commandFixture(f, "");
  expect((await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true, fetchTimeoutMs })).ok).toBe(false);
  expect(fs.readFileSync(calls, "utf8")).not.toContain("ls-remote");
  retained(f);
});
it("omitted fresh budget uses the existing default and real listing", async () => {
  const f = fixture("alternative"); const { calls } = commandFixture(f, "");
  expect(await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true })).toEqual({
    ok: true, head: f.head, branch: allocated, containedIn: alternative,
  });
  expect(fs.readFileSync(calls, "utf8")).toContain("ls-remote --heads origin");
});
it("an unused invalid budget does not reject the own-tracking fast path", async () => {
  const f = fixture("tracked"); const { calls } = commandFixture(f, "");
  expect(await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true, fetchTimeoutMs: NaN })).toEqual({
    ok: true, head: f.head, branch: allocated,
  });
  expect(fs.readFileSync(calls, "utf8")).not.toContain("ls-remote");
});
it("truthy nonboolean flags do not enable origin-head authority", async () => {
  const f = fixture("tracked");
  const options = Object.defineProperty({}, "allowOriginHeadAncestor", { value: 1 });
  expect(await parkWorktree(f.target, () => undefined, options)).toEqual({ ok: true, head: f.head });
});
it("own-tracking existence does not prove an unbacked later actual-branch commit", async () => {
  const f = fixture("own");
  fs.writeFileSync(path.join(f.tree, "later.txt"), "owned unbacked work\n");
  git(f.tree, ["add", "."]); git(f.tree, ["commit", "-qm", "later"]);
  const tip = git(f.tree, ["rev-parse", "HEAD"]);
  expect((await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true })).ok).toBe(false);
  expect(git(f.repo, ["rev-parse", actual])).toBe(tip);
  expect(fs.readFileSync(path.join(f.tree, "later.txt"), "utf8")).toContain("owned");
});
it("refuses detached HEAD and preserves its named branch", async () => {
  const f = fixture("tracked"); git(f.tree, ["checkout", "--detach", "-q"]);
  expect((await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true })).ok).toBe(false);
  retained(f);
});
it("retains the existing local-copy rule only for its allocated branch without origin", async () => {
  const f = fixture("alternative"); git(f.repo, ["remote", "remove", "origin"]);
  expect(await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true, fetchTimeoutMs: NaN })).toEqual({
    ok: true, head: f.head, branch: allocated,
  });
  expect(git(f.repo, ["rev-parse", allocated])).toBe(f.head);
});
it("does not authorize an unbacked other branch merely because origin is absent", async () => {
  const f = fixture("own"); git(f.repo, ["remote", "remove", "origin"]);
  expect((await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true })).ok).toBe(false);
  retained(f);
});

it.each(["--help", "g".repeat(40), "g".repeat(64), "a".repeat(40) + "\n--help"])(
  "invalid observed HEAD %s cannot enter a proof",
  async sha => {
    const f = fixture("tracked"); const output = path.join(f.root, "head");
    fs.writeFileSync(output, sha + "\n");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const { calls } = commandFixture(f, 'if [ "$1" = rev-parse ] && [ "$2" = --verify ] && [ "$3" = "HEAD^{commit}" ]; then cat ' + quote(output) + '; exit 0; fi');
    expect((await parkWorktree(f.target, () => undefined, { allowOriginHeadAncestor: true })).ok).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).not.toContain("merge-base");
    retained(f);
  }
);
it("uses complete SHA256 IDs from a real owned SHA256 origin", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "origin-park-sha256-")));
  roots.push(root);
  const repo = path.join(root, "repo"); const origin = path.join(root, "origin");
  fs.mkdirSync(repo); fs.mkdirSync(origin);
  git(repo, ["init", "-q", "--object-format=sha256", "-b", "main"]);
  for (const [key, value] of [
    ["user.email", "test@example.com"], ["user.name", "Test"],
    ["commit.gpgsign", "false"], ["maintenance.auto", "false"], ["gc.auto", "0"],
  ] as const) git(repo, ["config", key, value]);
  fs.writeFileSync(path.join(repo, "README.md"), "owned seed\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-qm", "seed"]);
  git(origin, ["init", "-q", "--bare", "--object-format=sha256", "-b", "main"]);
  git(origin, ["config", "receive.autogc", "false"]);
  git(repo, ["remote", "add", "origin", origin]); git(repo, ["push", "-q", "origin", "main"]);
  const tree = path.join(repo, ".worktrees", "worker");
  git(repo, ["worktree", "add", "-qb", allocated, tree]);
  fs.writeFileSync(path.join(tree, "owned.txt"), note);
  git(tree, ["add", "."]); git(tree, ["commit", "-qm", "owned"]);
  const head = git(tree, ["rev-parse", "HEAD"]); expect(head).toHaveLength(64);
  git(tree, ["push", "-q", "origin", "HEAD:refs/heads/" + alternative]);
  expect(await parkWorktree({ gitRoot: repo, worktree: tree, branch: allocated }, () => undefined, {
    allowOriginHeadAncestor: true,
  })).toEqual({ ok: true, head, branch: allocated, containedIn: alternative });
  expect(fs.existsSync(tree)).toBe(false);
  expect(git(repo, ["rev-parse", allocated])).toBe(head);
});
