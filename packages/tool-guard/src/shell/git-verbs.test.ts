import { describe, expect, it } from "vitest";
import { GIT_VERBS, autocorrectOff, readGitVerb } from "./git-verbs.js";

describe("the git verb table", () => {
  it.each(["push", "merge", "branch", "status", "commit", "checkout", "switch", "worktree", "config"])(
    "holds the guarded or everyday verb %j",
    (verb) => {
      expect(GIT_VERBS.has(verb)).toBe(true);
    },
  );

  it("is case-exact, so an upper-case spelling of a verb stays off it", () => {
    expect(GIT_VERBS.has("PUSH")).toBe(false);
  });

  // An external that is not installed autocorrects to a near alias, e.g. p4 to an alias p.
  it.each(["svn", "p4", "lfs", "gui", "citool", "send-email", "filter-repo", "cvsimport", "cvsexportcommit", "cvsserver", "archimport"])(
    "leaves the optional external %j off",
    (verb) => {
      expect(GIT_VERBS.has(verb)).toBe(false);
    },
  );

  it("holds exactly the 169 names git 2.53 lists for --list-cmds=builtins,main", () => {
    expect(GIT_VERBS.size).toBe(169);
  });
});

describe("reading a git subcommand word", () => {
  it("reads a verb on the table as known", () => {
    expect(readGitVerb("push")).toEqual({ verb: "push", known: true });
  });

  // A repo alias `statusx` is nearer to `status\r` than `status` is, and git ran it.
  it.each([
    ["push\r", "push"],
    ["push\r\r", "push"],
    ["status\r", "status"],
  ])("reads %j as %j for the guarded classifiers but keeps it unknown", (word, verb) => {
    expect(readGitVerb(word)).toEqual({ verb, known: false });
  });

  it.each(["psuh", "PUSH", "push ", "\rpush", "pus\rh", "frobnicate", "psuh\r"])(
    "leaves %j unchanged and unknown",
    (word) => {
      expect(readGitVerb(word)).toEqual({ verb: word, known: false });
    },
  );

  it("lets a CR-suffixed verb pass only when the same line turns help.autocorrect off", () => {
    const runsUnchecked = (word: string, config: string[]) => !readGitVerb(word).known && !autocorrectOff(config);

    expect(runsUnchecked("status\r", [])).toBe(true);
    expect(runsUnchecked("status\r", ["help.autocorrect=1"])).toBe(true);
    expect(runsUnchecked("status\r", ["help.autocorrect=never"])).toBe(false);
  });
});

describe("whether -c overrides turn help.autocorrect off", () => {
  it.each([[["help.autocorrect=never"]], [["help.AutoCorrect=0"]], [["help.autocorrect=show"]], [["help.autocorrect=OFF"]]])(
    "is off for %j",
    (config) => {
      expect(autocorrectOff(config)).toBe(true);
    },
  );

  it.each([
    [["help.autocorrect=prompt"]],
    [["help.autocorrect"]],
    [["help.autocorrect="]],
    [["help.autocorrect=Never"]],
    [["help.autocorrect=1"]],
    [["help.autocorrect=immediate"]],
    [["user.name=never"]],
    [[]],
  ])("stays on for %j", (config) => {
    expect(autocorrectOff(config)).toBe(false);
  });

  it("lets the last override win", () => {
    expect(autocorrectOff(["help.autocorrect=never", "help.autocorrect=1"])).toBe(false);
    expect(autocorrectOff(["help.autocorrect=1", "help.autocorrect=never"])).toBe(true);
  });
});
