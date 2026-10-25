import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { nodeContext } from "../context.js";
import type { ClassifyContext } from "../types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const TAG = "bash.release.git-push-tag";

/** A repository whose only local tag is `rc1`, wherever git runs, so a test shows which directories are looked in. */
const tagged: ClassifyContext = { home: HOME, readLink: () => null, readHead: () => "feat/x", readScript: () => null, isTag: (_dir, name) => name === "rc1" };

function spellings(command: string, ctx: ClassifyContext = tagged): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, ctx).map((a) => a.spelling);
}

describe("a bare version number", () => {
  it.each(["git push origin 1.2.0", "git push origin HEAD:2.0.1", "git push origin --delete 10.4"])("reads `%s` as a tag push", (command) => {
    expect(spellings(command)).toEqual([TAG]);
  });

  it.each(["git push origin feat/node-1.2", "git push origin 1.2.0:refs/heads/feat/x", "git push origin 12"])("leaves `%s` alone", (command) => {
    expect(spellings(command)).toEqual([]);
  });
});

describe("a name the local repository holds as a tag", () => {
  it.each(["git push origin rc1", "git push origin -d rc1", "git push origin :rc1", "git push origin HEAD:rc1", "git push origin +rc1:feat/x"])(
    "reads `%s` as a tag push",
    (command) => {
      expect(spellings(command)).toEqual([TAG]);
    },
  );

  it.each(["git push origin rc1:refs/heads/feat/x", "git push origin rc1:heads/feat/x", "git push origin feat/rc1", "git push origin HEAD:feat/x"])(
    "leaves `%s` alone",
    (command) => {
      expect(spellings(command)).toEqual([]);
    },
  );

  it.each(['git -C "$D" push origin rc1', "git --git-dir=.git push origin rc1", 'cd "$X" && git push origin rc1'])(
    "falls back to the name shapes from a directory it cannot name: `%s`",
    (command) => {
      expect(spellings(command)).toEqual([]);
      expect(spellings(command.replace("rc1", "v1"))).toEqual([TAG]);
    },
  );

  it("reads nothing as a local tag when the context has no tag port", () => {
    const portless: ClassifyContext = { ...tagged, isTag: undefined };

    expect(spellings("git push origin rc1", portless)).toEqual([]);
  });
});

describe("git push long options read by unique prefix", () => {
  it.each(["git push --tag origin", "git push --fol origin feat/x", "git push --follow origin feat/x"])("reads `%s` as a tag push", (command) => {
    expect(spellings(command)).toEqual([TAG]);
  });

  it.each(["git push --no-fol origin feat/x", "git push --no-ta origin feat/x", "git push --fo origin feat/x"])("leaves `%s` alone", (command) => {
    expect(spellings(command)).toEqual([]);
  });
});

describe("nodeContext tag lookup over a real temp directory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function worktreeWithTags(): { home: string; wt: string } {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tool-guard-tags-")));
    dirs.push(home);
    const git = (rel: string) => path.join(home, "app/.git", rel);
    fs.mkdirSync(git("refs/tags/@scope"), { recursive: true });
    fs.writeFileSync(git("HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(git("refs/tags/rc1"), "1".repeat(40) + "\n");
    fs.writeFileSync(git("refs/tags/@scope/a"), "1".repeat(40) + "\n");
    fs.writeFileSync(git("packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${"2".repeat(40)} refs/tags/nightly\n^${"3".repeat(40)}\n`);
    fs.mkdirSync(git("worktrees/wt"), { recursive: true });
    fs.writeFileSync(git("worktrees/wt/HEAD"), "ref: refs/heads/feat/x\n");
    fs.writeFileSync(git("worktrees/wt/commondir"), "../..\n");
    fs.mkdirSync(path.join(home, "wt"));
    fs.writeFileSync(path.join(home, "wt/.git"), "gitdir: ../app/.git/worktrees/wt\n");
    return { home, wt: path.join(home, "wt") };
  }

  it("finds loose and packed tags in a worktree's common directory, and only names inside the tag tree", () => {
    const { home, wt } = worktreeWithTags();
    const ctx = nodeContext(home);

    const found = ["rc1", "@scope/a", "nightly", "feat/x", "../../HEAD", "@scope", "rc1/"].map((name) => ctx.isTag?.(wt, name));

    expect(found).toEqual([true, true, true, false, false, false, false]);
    expect(ctx.isTag?.(path.join(home, "app"), "nightly")).toBe(true);
  });

  it("reads a push of a local tag as a tag push, and the branch beside it as nothing", () => {
    const { home, wt } = worktreeWithTags();
    const ctx = nodeContext(home);
    const push = (command: string) => classify({ kind: "bash", command, cwd: wt, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => a.spelling);

    expect([push("git push origin rc1"), push("git push origin feat/x")]).toEqual([[TAG], []]);
  });
});
