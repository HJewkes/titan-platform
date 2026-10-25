import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { extractCommands } from "../shell/commands.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";
import { AMBIGUOUS_LONG, GIT_PUSH_LONG, resolveLong } from "./long-options.js";
import { checkPreferences } from "./preference.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const gitPush = resolveLong(GIT_PUSH_LONG, false);

const ctx: ClassifyContext = { home: HOME, readLink: () => null, readHead: (dir) => (dir === REPO ? "feat/x" : null), readScript: () => null };
const event = (command: string) => ({ kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null });
const spellings = (command: string) => classify(event(command), ctx).map((a: ClassifiedAction) => a.spelling);
const ruleIds = (command: string) => checkPreferences(extractCommands(command, { cwd: REPO, home: HOME }), { seat: false }).map((h) => h.id);

describe("the git push option table matches git 2.53.0", () => {
  it("every git push name resolves to itself", () => {
    expect(GIT_PUSH_LONG.names.filter((n) => gitPush(`--${n}`) !== `--${n}`)).toEqual([]);
  });

  it("holds every git push long option, and reads its prefixes as git does", () => {
    expect(GIT_PUSH_LONG.names).toHaveLength(52);
    expect([...GIT_PUSH_LONG.values].sort()).toEqual(["--exec", "--push-option", "--receive-pack", "--recurse-submodules", "--repo"]);
    expect(["--tag", "--fol", "--mirr", "--al", "--fo", "--no-ta"].map(gitPush)).toEqual(["--tags", "--follow-tags", "--mirror", "--all", AMBIGUOUS_LONG, "--no-tags"]);
  });
});

describe("a git push long option given as a unique prefix reads as the option git runs", () => {
  it.each(["git push --tag origin", "git push --fol origin feat/x", "git push --follow origin feat/x", "git push --del origin v1"])(
    "%s reads as a tag push",
    (command) => {
      expect(spellings(command)).toEqual(["bash.release.git-push-tag"]);
    },
  );

  it.each(["git push --mirr origin", "git push --al origin"])("%s reads as a push of every branch", (command) => {
    expect(spellings(command)).toEqual(["bash.merge.git-push-all"]);
  });

  it.each([
    ["--no-fol, which turns tags off", "git push --no-fol origin feat/x"],
    ["--fo, which git refuses as ambiguous", "git push --fo origin feat/x"],
  ])("leaves %s alone", (_what, command) => {
    expect(spellings(command)).toEqual([]);
  });
});

describe("preference rules read push options through the same reader", () => {
  it("R31 matches a branch delete spelled --del beside another command", () => {
    expect(ruleIds("git fetch && git push origin --del feat/x")).toContain("R31");
  });

  it("R164 matches --no-verif, which git reads as --no-verify", () => {
    expect(ruleIds("git push --no-verif origin feat/x")).toContain("R164");
  });
});
