import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { extractCommands } from "./commands.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "feat/x" : null),
  readScript: () => null,
};

function spellings(command: string): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, context).map((a) => a.spelling);
}

const gitArgs = (command: string) =>
  extractCommands(command).filter((c) => c.name === "git").map((c) => c.args.map((a) => a.value));

describe("variables built up before the command they name", () => {
  it.each([
    ["a plain append", "Y=pu; Y+=sh; git $Y origin HEAD:main"],
    ["a declared append", "declare Y=pu; declare Y+=sh; git $Y origin HEAD:main"],
    ["an exported append", "export Y=pu; export Y+=sh; git $Y origin HEAD:main"],
    ["an append of a known variable", "A=sh; Y=pu; Y+=$A; git $Y origin HEAD:main"],
    ["printf -v with the name attached", "X=status; printf -vX push; git $X origin HEAD:main"],
    ["printf -v with the name apart", "X=status; printf -v X push; git $X origin HEAD:main"],
  ])("%s still reads as a push to main", (_, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it("does not run an append as a command", () => {
    expect(extractCommands("Y=pu; Y+=sh").map((c) => c.name)).toEqual([]);
  });

  it("joins two literal parts into the value the command sees", () => {
    expect(gitArgs("Y=pu; Y+=sh; git $Y origin HEAD:main")).toEqual([["push", "origin", "HEAD:main"]]);
  });

  it.each([
    ["a command substitution", "Y=pu; Y+=$(cmd); git $Y origin HEAD:main"],
    ["an unset earlier value", "Y+=sh; git $Y origin HEAD:main"],
  ])("leaves the variable unknown when appending %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["$Y", "origin", "HEAD:main"]]);
  });

  it("stores the text printf -vNAME would print", () => {
    expect(gitArgs("X=status; printf -vX '%s%s' pu sh; git $X")).toEqual([["push"]]);
  });

  it("forgets the old value when printf -vNAME prints something unknown", () => {
    expect(gitArgs("X=status; printf -vX %s \"$(cmd)\"; git $X")).toEqual([["$X"]]);
  });
});
