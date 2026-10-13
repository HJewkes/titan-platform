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
});

describe("reading a git subcommand word", () => {
  it("reads a verb on the table as known", () => {
    expect(readGitVerb("push")).toEqual({ verb: "push", known: true });
  });

  it.each(["push\r", "push\r\r"])("reads a known verb with trailing CRs %j as that verb", (word) => {
    expect(readGitVerb(word)).toEqual({ verb: "push", known: true });
  });

  it.each(["psuh", "PUSH", "push ", "\rpush", "pus\rh", "frobnicate", "psuh\r"])(
    "leaves %j unchanged and unknown",
    (word) => {
      expect(readGitVerb(word)).toEqual({ verb: word, known: false });
    },
  );
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
