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
    ["a -vNAME word printf only prints", "X=push; printf '%s\\n' -vX; git $X origin HEAD:main"],
    ["a -vNAME word after --", "X=push; printf -- -vX; git $X origin HEAD:main"],
    ["an array append to a set variable", "Y=push; Y+=(x); git $Y origin HEAD:main"],
    ["an empty array append", "Y=push; Y+=(); git $Y origin HEAD:main"],
    ["a spaced array append", "Y=push; Y+=( x ); git $Y origin HEAD:main"],
    ["a declared array append", "Y=push; declare Y+=(x); git $Y origin HEAD:main"],
    ["a declare -a array append", "Y=push; declare -a Y+=(x); git $Y origin HEAD:main"],
    ["a local append in a function", "Y=status; f() { local Y+=push; git $Y origin HEAD:main; }; f"],
    ["a declare append in a function", "Y=status; f() { declare Y+=push; git $Y origin HEAD:main; }; f"],
    ["a typeset append in a function", "Y=status; f() { typeset Y+=push; git $Y origin HEAD:main; }; f"],
    ["a local array append in a function", "Y=status; f() { local Y+=(push); git $Y origin HEAD:main; }; f"],
    ["a push in a function keyword body", "function f { git push origin HEAD:main; }"],
    ["a declare append in a function keyword body", "Y=status; function f { declare Y+=push; git $Y origin HEAD:main; }; f"],
    ["a declare append in a subshell body", "Y=status; f() ( declare Y+=push; git $Y origin HEAD:main ); f"],
    ["a global append in a function", "Y=pu; f() { declare -g Y+=sh; git $Y origin HEAD:main; }; f"],
    ["an export append in a function", "Y=pu; f() { export Y+=sh; git $Y origin HEAD:main; }; f"],
    ["a declare append after a function body", "f() { :; }; Y=pu; declare Y+=sh; git $Y origin HEAD:main"],
    ["a declare append in a plain group", "Y=pu; { declare Y+=sh; git $Y origin HEAD:main; }"],
    ["an array's element 0", "Y=(push x); git $Y origin HEAD:main"],
    ["an append to an array's element 0", "Y=(pu); Y+=sh; git $Y origin HEAD:main"],
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
    ["an array to an unset variable", "Y+=(sh); git $Y origin HEAD:main"],
  ])("leaves the variable unknown when appending %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["$Y", "origin", "HEAD:main"]]);
  });

  it.each([
    ["an array to a set variable", "Y=pu; Y+=(sh); git $Y"],
    ["through declare to an array", "declare -a Y=(pu); declare Y+=(sh); git $Y"],
  ])("keeps element 0 when appending %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["pu"]]);
  });

  it.each([
    ["empty", "Y=(); git $Y"],
    ["led by a substitution", "Y=($(cmd) x); git $Y"],
    ["led by a subscript", "Y=([1]=push); git $Y"],
    ["led by a glob", "Y=(pu*); git $Y"],
  ])("leaves an array %s unknown", (_, command) => {
    expect(gitArgs(command)).toEqual([["$Y"]]);
  });

  it("still runs a substitution inside an array", () => {
    expect(extractCommands("Y=(a $(git push origin HEAD:main))").map((c) => c.name)).toEqual(["git"]);
  });

  it("stores the text printf -vNAME would print", () => {
    expect(gitArgs("X=status; printf -vX '%s%s' pu sh; git $X")).toEqual([["push"]]);
  });

  it("forgets the old value when printf -vNAME prints something unknown", () => {
    expect(gitArgs("X=status; printf -vX %s \"$(cmd)\"; git $X")).toEqual([["$X"]]);
  });
});
