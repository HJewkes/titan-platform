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
    ["a local append undone on return", "Y=push; f() { local Y+=x; }; f; git $Y origin HEAD:main"],
    ["a declare append undone on return", "Y=push; f() { declare Y+=x; }; f; git $Y origin HEAD:main"],
    ["a local undone on return (TP-1473)", "Y=push; f() { local Y=status; }; f; git $Y origin HEAD:main"],
    ["a typeset local undone on return (TP-1473)", "Y=push; function f { typeset Y=status; }; f; git $Y origin HEAD:main"],
    ["a global set in a function", "Y=status; f() { Y=push; }; f; git $Y origin HEAD:main"],
    ["a declare -g set in a function", "Y=status; f() { declare -g Y=push; }; f; git $Y origin HEAD:main"],
    ["a pipe to bash after an empty case", "case x in esac; echo 'git push origin HEAD:main' | bash"],
    ["a pipe to sh after an empty case", "case x in esac; echo 'git push origin HEAD:main' | sh"],
    ["a local in a subshell of a function", "Y=push; f() { ( local Y=status ); }; f; git $Y origin HEAD:main"],
    ["a local whose slot name the user writes", "Y=push; f() { local Y=x; __tool_guard_local_0=status; }; f; git $Y origin HEAD:main"],
    ["a local whose hidden slot name the user writes", "Y=push; f() { local Y=x; local@0=status; }; f; git $Y origin HEAD:main"],
    ["a local whose hidden slot printf -v targets", "Y=push; f() { local Y=x; printf -v local@0 status; }; f; git $Y origin HEAD:main"],
    ["a local whose hidden slot printf -vNAME targets", "Y=push; f() { local Y=x; printf -vlocal@0 status; }; f; git $Y origin HEAD:main"],
    ["a local whose hidden slot read targets", "Y=push; f() { local Y=x; read local@0; }; f; git $Y origin HEAD:main"],
    ["a local whose hidden slot unset targets", "Y=push; f() { local Y=x; unset local@0; }; f; git $Y origin HEAD:main"],
    ["a local whose hidden slot for targets", "Y=push; f() { local Y=x; for local@0 in a; do :; done; }; f; git $Y origin HEAD:main"],
    ["an esac pattern in a parenthesised case pattern", "f() ( case a in (a|esac) declare Y+=push;; esac; git $Y origin HEAD:main ); Y=status; f"],
    ["an esac argument in a case body", "f() ( case a in a) echo esac;; b) :;; esac; declare Y+=push; git $Y origin HEAD:main ); Y=status; f"],
    ["a declare append after a case pattern", "Y=status; f() ( case a in a) declare Y+=push; git $Y origin HEAD:main;; esac ); f"],
    ["an append to an array's element 0", "Y=(pu); Y+=sh; git $Y origin HEAD:main"],
    ["an element 0 assignment (TP-1491)", "Y=status; Y[0]=push; git $Y origin HEAD:main"],
    ["a declared element 0 (TP-1491)", "Y=status; declare 'Y[0]=push'; git $Y origin HEAD:main"],
    ["a typeset element 0 (TP-1491)", "Y=status; typeset 'Y[0]=push'; git $Y origin HEAD:main"],
    ["an exported element 0 (TP-1491)", "Y=status; export 'Y[0]=push'; git $Y origin HEAD:main"],
    ["a local element 0 in a function (TP-1491)", "Y=status; f() { local 'Y[0]=push'; git $Y origin HEAD:main; }; f"],
    ["a local element 0 undone on return (TP-1491)", "Y=push; f() { local 'Y[0]=status'; }; f; git $Y origin HEAD:main"],
    ["an element assignment before the command (TP-1491)", "Y[0]=x git push origin HEAD:main"],
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
    ["a read into a subscripted target", "Y=status; read 'Y[0]' <<< push; git $Y"],
    ["a printf -v into a subscripted target", "Y=status; printf -v 'Y[0]' push; git $Y"],
    ["a printf -v into an attached subscripted target", "Y=status; printf -v'Y[0]' push; git $Y"],
    ["an element 1 assignment (TP-1491)", "Y=status; Y[1]=push; git $Y"],
    ["an element assignment at a run-time index (TP-1491)", "Y=status; Y[i]=push; git $Y"],
    ["an append to element 0 (TP-1491)", "Y=pu; Y[0]+=sh; git $Y"],
    ["a declared element at a run-time index (TP-1491)", "Y=status; declare 'Y[i]=push'; git $Y"],
    ["an element assignment before another command (TP-1491)", "Y=status; Y[0]=push true; git $Y"],
    ["mapfile (TP-1491)", "Y=status; mapfile Y < list; git $Y"],
    ["mapfile with options (TP-1491)", "Y=status; mapfile -t -d , Y < list; git $Y"],
    ["readarray (TP-1491)", "Y=status; readarray Y < list; git $Y"],
  ])("leaves the variable unknown after %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["$Y"]]);
  });

  it("leaves MAPFILE unknown after a mapfile with no name (TP-1491)", () => {
    expect(gitArgs("MAPFILE=status; mapfile < list; git $MAPFILE")).toEqual([["$MAPFILE"]]);
  });

  it("classifies a push whose subcommand is an unknown variable as no guarded action", () => {
    expect(spellings("Y=status; mapfile Y < list; git $Y origin HEAD:main")).toEqual([]);
  });

  it.each([
    ["empty", "Y=(); git $Y"],
    ["led by a substitution", "Y=($(cmd) x); git $Y"],
    ["led by a subscript", "Y=([1]=push); git $Y"],
    ["led by a glob", "Y=(pu*); git $Y"],
    ["led by a brace list", "Y=({push,x}); git $Y"],
    ["led by a brace suffix", "Y=(pu{sh,x}); git $Y"],
    ["with a later [0]= element", "Y=(x [0]=push); git $Y"],
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
