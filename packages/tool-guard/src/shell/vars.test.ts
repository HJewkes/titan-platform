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

const pushSubjects = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, context)
    .filter((a) => a.spelling === "bash.merge.git-push-protected")
    .map((a) => a.subject);

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
    ["a declare element with an invalid option (TP-1491)", "Y=push; declare -Q 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare element with a glob option (TP-1491)", "Y=push; declare -[r] 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare scalar with an invalid option (TP-1491)", "Y=push; declare -Q Y=status; git $Y origin HEAD:main"],
    ["a typeset scalar with an invalid +option (TP-1491)", "Y=push; typeset +Q Y=status; git $Y origin HEAD:main"],
    ["a local scalar with an invalid option (TP-1491)", "Y=push; f() { local -Q Y=status; git $Y origin HEAD:main; }; f"],
    ["an export with a declare-only option (TP-1491)", "Y=push; export -r Y=status; git $Y origin HEAD:main"],
    ["an export with a glob option (TP-1491)", "Y=push; export -* Y=status; git $Y origin HEAD:main"],
    ["a readonly with a declare-only option (TP-1491)", "Y=push; readonly -x Y=status; git $Y origin HEAD:main"],
    ["a declare -p element that only prints (TP-1491)", "Y=push; declare -p 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare -f element that names a function (TP-1491)", "Y=push; declare -f 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare -F element that names a function (TP-1491)", "Y=push; declare -F 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a typeset -f element that names a function (TP-1491)", "Y=push; typeset -f 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare -g element bash 3.2 rejects (TP-1491)", "Y=push; declare -g 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare -l scalar bash 5 lowercases (TP-1491)", "Y=push; declare -l Y=status; git $Y origin HEAD:main"],
    ["a declare -u scalar bash 5 uppercases (TP-1491)", "Y=push; declare -u Y=status; git $Y origin HEAD:main"],
    ["a declare -A element bash 3.2 rejects (TP-1491)", "Y=push; declare -A 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare -n scalar that names a reference (TP-1491)", "Y=push; declare -n Y=status; git $Y origin HEAD:main"],
    ["an export -f scalar that names a function (TP-1491)", "Y=push; export -f Y=status; git $Y origin HEAD:main"],
    ["a readonly -f scalar that names a function (TP-1491)", "Y=push; readonly -f Y=status; git $Y origin HEAD:main"],
    ["a declare with a lone dash (TP-1491)", "Y=push; declare - Y=status; git $Y origin HEAD:main"],
    ["a run-time declare word (TP-1491)", "Y=status; F=$(cmd); declare \"$F\"; git $Y origin HEAD:main"],
    ["a substituted export word (TP-1491)", "Y=status; export $(cmd); git $Y origin HEAD:main"],
    ["a run-time typeset word (TP-1491)", "Y=status; F=$(cmd); typeset $F; git $Y origin HEAD:main"],
    ["a run-time local word (TP-1491)", "Y=status; F=$(cmd); f() { local \"$F\"; git $Y origin HEAD:main; }; f"],
    ["a run-time readonly word (TP-1491)", "Y=status; F=$(cmd); readonly \"$F\"; git $Y origin HEAD:main"],
    ["an element 0 assignment (TP-1491)", "Y=status; Y[0]=push; git $Y origin HEAD:main"],
    ["a declared element 0 (TP-1491)", "Y=status; declare 'Y[0]=push'; git $Y origin HEAD:main"],
    ["a typeset element 0 (TP-1491)", "Y=status; typeset 'Y[0]=push'; git $Y origin HEAD:main"],
    ["an exported element 0 bash rejects (TP-1491)", "Y=push; export 'Y[0]=status'; git $Y origin HEAD:main"],
    ["an unquoted exported element 0 bash rejects (TP-1491)", "Y=push; export Y[0]=status; git $Y origin HEAD:main"],
    ["a readonly element 0 bash rejects (TP-1491)", "Y=push; readonly 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare -x element 0 bash assigns (TP-1491)", "Y=status; declare -x 'Y[0]=push'; git $Y origin HEAD:main"],
    ["a declare -a element 0 bash assigns (TP-1491)", "Y=status; declare -a 'Y[0]=push'; git $Y origin HEAD:main"],
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
    ["an exported element 0 with a value bash rejects (TP-1491)", "Y=$(cmd); export 'Y[0]=push'; git $Y"],
    ["a declare -r element 0 (TP-1491)", "Y=push; declare -r 'Y[0]=status'; git $Y"],
    ["a typeset -r element 0 (TP-1491)", "Y=push; typeset -r 'Y[0]=status'; git $Y"],
    ["a declare -xr element 0 (TP-1491)", "Y=push; declare -xr 'Y[0]=status'; git $Y"],
    ["an unquoted declare -r element 0 (TP-1491)", "Y=push; declare -r Y[0]=status; git $Y"],
    ["a declare -ra element 0 (TP-1491)", "Y=push; declare -ra 'Y[0]=status'; git $Y"],
    ["a declare -r -x element 0 (TP-1491)", "Y=push; declare -x -r 'Y[0]=status'; git $Y"],
    ["a local -r element 0 in a function (TP-1491)", "Y=push; f() { local -r 'Y[0]=status'; git $Y; }; f"],
    ["a declare with a run-time option (TP-1491)", "Y=push; F=$(cmd); declare $F 'Y[0]=status'; git $Y"],
    ["a declare with a quoted run-time option (TP-1491)", "Y=push; F=$(cmd); declare \"$F\" 'Y[0]=status'; git $Y"],
    ["a declare with a braced run-time option (TP-1491)", "Y=push; F=$(cmd); declare ${F} 'Y[0]=status'; git $Y"],
    ["a declare with a substituted option (TP-1491)", "Y=push; declare $(cmd) 'Y[0]=status'; git $Y"],
    ["a declare with a backquoted option (TP-1491)", "Y=push; declare `cmd` 'Y[0]=status'; git $Y"],
    ["a declare with a partly run-time option (TP-1491)", "Y=push; F=$(cmd); declare -$F 'Y[0]=status'; git $Y"],
    ["a typeset with a run-time option (TP-1491)", "Y=push; F=$(cmd); typeset $F 'Y[0]=status'; git $Y"],
    ["a local with a run-time option (TP-1491)", "Y=push; F=$(cmd); f() { local $F 'Y[0]=status'; git $Y; }; f"],
    ["mapfile (TP-1491)", "Y=status; mapfile Y < list; git $Y"],
    ["mapfile with options (TP-1491)", "Y=status; mapfile -t -d , Y < list; git $Y"],
    ["readarray (TP-1491)", "Y=status; readarray Y < list; git $Y"],
  ])("leaves the variable unknown after %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["$Y"]]);
  });

  it("leaves MAPFILE unknown after a mapfile with no name (TP-1491)", () => {
    expect(gitArgs("MAPFILE=status; mapfile < list; git $MAPFILE")).toEqual([["$MAPFILE"]]);
  });

  it("classifies a push whose subcommand is an unknown variable as a push to an unknown branch", () => {
    expect(pushSubjects("Y=status; mapfile Y < list; git $Y origin HEAD:main")).toEqual([{ branch: "unknown" }]);
  });

  it.each([
    ["a declare -r element 0", "Y=push; declare -r 'Y[0]=status'; git $Y origin HEAD:main"],
    ["a declare with a run-time option", "Y=push; F=$(cmd); declare $F 'Y[0]=status'; git $Y origin HEAD:main"],
  ])("classifies a push after %s as a push to an unknown branch (TP-1491)", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "unknown" }]);
  });

  it.each([
    ["declare -airtx", "declare -airtx Z=1; git $Y"],
    ["typeset +x", "typeset +x Z=1; git $Y"],
    ["local -r in a function", "f() { local -r Z=1; git $Y; }; f"],
    ["export -n", "export -n Z=1; git $Y"],
    ["readonly -a", "readonly -a Z=1; git $Y"],
    ["declare --", "declare -- Z=1; git $Y"],
  ])("keeps a variable known after %s, whose options assign as written (TP-1491)", (_, command) => {
    expect(gitArgs(`Y=status; ${command}`)).toEqual([["status"]]);
  });

  it("keeps a variable known after a literal declaration of another (TP-1491)", () => {
    expect(gitArgs("Y=status; declare Z=1; git $Y")).toEqual([["status"]]);
  });

  it("forgets HOME after a run-time declaration word (TP-1491)", () => {
    const cat = (command: string) => extractCommands(command, { cwd: REPO, home: "/home/you" }).at(-1)?.args[0]?.value;
    expect([cat("declare Z=1; cat $HOME/x"), cat("declare \"$F\"; cat $HOME/x")]).toEqual(["/home/you/x", "$HOME/x"]);
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

describe("writes to a readonly variable, which bash rejects (TP-1501)", () => {
  it.each([
    ["a plain write", "readonly Y=push; Y=status; git $Y origin HEAD:main"],
    ["an element write", "declare -r Y=push; Y[0]=status; git $Y origin HEAD:main"],
    ["read", "readonly Y=push; read Y; git $Y origin HEAD:main"],
    ["printf -v", "readonly Y=push; printf -v Y status; git $Y origin HEAD:main"],
    ["mapfile", "readonly Y=push; mapfile Y < list; git $Y origin HEAD:main"],
    ["a later declare", "readonly Y=push; declare Y=status; git $Y origin HEAD:main"],
    ["unset", "readonly Y=push; unset Y; git $Y origin HEAD:main"],
    ["an element write before a command", "readonly Y=push; Y[0]=status true; git $Y origin HEAD:main"],
    ["a local over a readonly global", "readonly Y=push; f() { local Y=status; git $Y origin HEAD:main; }; f"],
    ["a readonly name listed alone", "Y=push; readonly Y; Y=status; git $Y origin HEAD:main"],
    ["a write in a subshell", "readonly Y=push; ( Y=status; git $Y origin HEAD:main )"],
  ])("keeps %s from changing the subcommand", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "main" }]);
  });

  it.each([
    ["readonly -a", "Y=push; readonly -a Y=status; git $Y origin HEAD:main"],
    ["declare -ra", "Y=push; declare -ra Y=status; git $Y origin HEAD:main"],
    ["declare -a -r", "Y=push; declare -a -r Y=status; git $Y origin HEAD:main"],
    ["typeset -ar", "Y=push; typeset -ar Y=status; git $Y origin HEAD:main"],
  ])("still reads a push after %s, which bash 3.2 rejects", (_, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a plain write", "readonly Y=push; Y=status; git $Y"],
    ["an element write", "declare -r Y=push; Y[0]=status; git $Y"],
    ["read", "readonly Y=push; read Y; git $Y"],
    ["a later declare", "readonly Y=push; declare Y=status; git $Y"],
    ["a later readonly", "readonly Y=push; readonly Y=status; git $Y"],
  ])("keeps the old value after %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["push"]]);
  });

  it.each([
    ["a non-readonly variable", "Y=push; Y=status; git $Y"],
    ["a readonly variable in a subshell that ended", "Y=push; ( readonly Y=x ); Y=status; git $Y"],
    ["a -r word after a name, which bash reads as a name", "declare Y=push -r; Y=status; git $Y"],
    ["an export -n", "export -n Y=push; Y=status; git $Y"],
  ])("tracks the new value of %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["status"]]);
  });

  it.each([
    ["a function's local -r ended", "Y=status; f() { local -r Y=x; }; f; Y=push; git $Y origin HEAD:main"],
    ["a run-time declaration word", "F=$(cmd); declare $F; Z=status; git $Z origin HEAD:main"],
    ["eval, which keeps readonly in a scope of its own", "readonly Y=push; eval 'Y=status; git $Y origin HEAD:main'"],
    ["a child shell, which drops readonly", "readonly Y=status; export Y; bash -c 'Y=push; git $Y origin HEAD:main'"],
  ])("still reads a push after %s may or may not leave a variable readonly", (_, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["after a false &&", "Y=status; false && readonly Y; Y=push; git $Y origin HEAD:main"],
    ["after a true ||", "Y=status; true || readonly Y; Y=push; git $Y origin HEAD:main"],
    ["in an untaken if", "Y=status; if false; then readonly Y; fi; Y=push; git $Y origin HEAD:main"],
    ["with a value in an untaken if", "Y=status; if false; then readonly Y=status; fi; Y=push; git $Y origin HEAD:main"],
    ["in an unmatched case arm", "Y=status; case a in b) readonly Y;; esac; Y=push; git $Y origin HEAD:main"],
    ["in a while false body", "Y=status; while false; do readonly Y; done; Y=push; git $Y origin HEAD:main"],
    ["in an uncalled function", "Y=status; f() { readonly Y; }; Y=push; git $Y origin HEAD:main"],
    ["as a top-level local -r", "Y=status; local -r Y; Y=push; git $Y origin HEAD:main"],
    ["piped to cat", "Y=status; readonly Y | cat; Y=push; git $Y origin HEAD:main"],
    ["in the background", "Y=status; readonly Y & Y=push; git $Y origin HEAD:main"],
    ["in a group after a false &&", "Y=status; false && { readonly Y; }; Y=push; git $Y origin HEAD:main"],
    ["in a piped group", "Y=status; { readonly Y; } | cat; Y=push; git $Y origin HEAD:main"],
    ["in an uncalled function keyword body", "Y=status; function f { readonly Y; }; Y=push; git $Y origin HEAD:main"],
    ["after a newline that continues &&", "Y=status; false &&\nreadonly Y; Y=push; git $Y origin HEAD:main"],
    ["after a newline that continues ||", "Y=status; true ||\nreadonly Y; Y=push; git $Y origin HEAD:main"],
    ["after a newline that continues a pipe", "Y=status; false |\nreadonly Y; Y=push; git $Y origin HEAD:main"],
    ["after a comment and newline that continue &&", "Y=status; false && # c\nreadonly Y; Y=push; git $Y origin HEAD:main"],
    ["under env", "Y=status; env readonly Y; Y=push; git $Y origin HEAD:main"],
    ["under nohup", "Y=status; nohup readonly Y; Y=push; git $Y origin HEAD:main"],
    ["under sudo", "Y=status; sudo readonly Y; Y=push; git $Y origin HEAD:main"],
    ["under timeout", "Y=status; timeout 1 readonly Y; Y=push; git $Y origin HEAD:main"],
    ["under xargs", "Y=status; echo Y | xargs readonly; Y=push; git $Y origin HEAD:main"],
    ["under xargs -I", "Y=status; echo Y | xargs -I{} readonly {}; Y=push; git $Y origin HEAD:main"],
    ["under coproc", "Y=status; coproc readonly Y; Y=push; git $Y origin HEAD:main"],
    ["in a coproc group", "Y=status; coproc { readonly Y; }; Y=push; git $Y origin HEAD:main"],
    ["in a case arm reached by ;&", "Y=status; case x in y) :;& z) readonly Y;; esac; Y=push; git $Y origin HEAD:main"],
  ])("still reads a later write after a readonly bash may never run %s", (_, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["after a plain command", "false; readonly Y=push; Y=status; git $Y"],
    ["in a plain group", "{ readonly Y=push; }; Y=status; git $Y"],
    ["after a closed if", "if true; then :; fi; readonly Y=push; Y=status; git $Y"],
    ["before an &&", "readonly Y=push && Y=status; git $Y"],
    ["under builtin", "builtin readonly Y=push; Y=status; git $Y"],
    ["under command", "command readonly Y=push; Y=status; git $Y"],
  ])("keeps the old value after a readonly that surely runs %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["push"]]);
  });

  it("restores a function local's outer value even while it is readonly", () => {
    expect(gitArgs("Y=push; f() { local -r Y=status; }; f; git $Y")).toEqual([["push"]]);
  });
});

describe("writes to a variable with a case attribute (TP-1497)", () => {
  it.each([
    ["declare -l", "declare -l Y; Y=PUSH; git $Y origin HEAD:main"],
    ["declare -l with a value", "declare -l Y=PUSH; git $Y origin HEAD:main"],
    ["declare -u", "declare -u Y; Y=Push; git $Y origin HEAD:main"],
    ["typeset -l", "typeset -l Y; Y=PUSH; git $Y origin HEAD:main"],
    ["local -l", "f() { local -l Y; Y=PUSH; git $Y origin HEAD:main; }; f"],
    ["declare -lx", "declare -lx Y; Y=PUSH; git $Y origin HEAD:main"],
    ["declare -l -x", "declare -x -l Y; Y=PUSH; git $Y origin HEAD:main"],
    ["a later declare", "declare -l Y; declare Y=PUSH; git $Y origin HEAD:main"],
    ["an append", "declare -l Y; Y=pu; Y+=SH; git $Y origin HEAD:main"],
    ["printf -v", "declare -l Y; printf -v Y PUSH; git $Y origin HEAD:main"],
    ["a non-ASCII letter a locale may map to ASCII", "declare -l Y; Y=puſh; git $Y origin HEAD:main"],
    ["declare -l after a false &&", "false && declare -l Y; Y=PUSH; git $Y origin HEAD:main"],
    ["declare -l in an uncalled function", "f() { declare -l Y; }; Y=PUSH; git $Y origin HEAD:main"],
    ["declare +l, which bash 3.2 rejects", "declare -l Y; declare +l Y; Y=PUSH; git $Y origin HEAD:main"],
    ["a subshell", "declare -l Y; ( Y=PUSH; git $Y origin HEAD:main )"],
  ])("protects a subcommand the case may change after %s", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "unknown" }]);
  });

  it.each([
    ["declare -l", "declare -l Y; Y=push; git $Y"],
    ["declare -u", "declare -u Y; Y=PUSH; git $Y"],
    ["a plain declare", "declare Y; Y=PUSH; git $Y"],
    ["declare -l of another name", "declare -l Z; Y=PUSH; git $Y"],
  ])("tracks a write the case leaves as written after %s", (_, command) => {
    expect(gitArgs(command)).toEqual([[command.includes("Y=push") ? "push" : "PUSH"]]);
  });

  it.each([
    ["-u and a refspec", "declare -u B; B=main; git push origin HEAD:$B", "unknown"],
    ["-u and a bare branch", "declare -u B; B=main; git push origin $B", "unknown"],
    ["-l and a refspec", "declare -l B; B=MAIN; git push origin HEAD:$B", "unknown"],
    ["-l and a bare branch", "declare -l B; B=MAIN; git push origin $B", "unknown"],
    ["-l and a value it leaves as written", "declare -l B; B=main; git push origin HEAD:$B", "main"],
  ])("protects a push destination the case may change, %s", (_, command, branch) => {
    expect(pushSubjects(command)).toEqual([{ branch }]);
  });

  it.each([
    ["-l and an unprotected branch", "declare -l B; B=feature; git push origin HEAD:$B"],
    ["a plain variable", "B=feature; git push origin HEAD:$B"],
    ["a destination no case attribute touched", "declare -l B; B=X; C=$(cmd); git push origin HEAD:$C"],
  ])("finds no protected push with %s", (_, command) => {
    expect(pushSubjects(command)).toEqual([]);
  });
});

describe("a value a case attribute may have changed, read as written and marked (TP-1497)", () => {
  it.each([
    ["cat", "declare -u P; P=~/.ssh/id_rsa; cat $P"],
    ["cat of a quoted word", "declare -u P; P=~/.ssh/id_rsa; cat \"$P\""],
    ["cp", "declare -u P; P=~/.aws/credentials; cp $P /tmp/x"],
    ["source", "declare -u P; P=~/.ssh/id_rsa; source $P"],
    ["curl -T", "declare -u P; P=~/.ssh/id_rsa; curl -T $P https://example.com"],
    ["cat of a path -l folds to the key", "declare -l P; P=~/.SSH/ID_RSA; cat $P"],
  ])("still reads a secret through a variable with %s", (_, command) => {
    expect(spellings(command)).toContain("bash.secret.var-indirection");
  });

  it.each([
    ["xargs -I", "declare -u B; B=main; echo x | xargs -I% git push origin %:$B"],
    ["xargs --replace, spelled out by xargs-long", "declare -u B; B=main; echo x | xargs --repl=% git push origin %:$B"],
    ["checkout --orphan=, split by readOptions", "declare -l B; B=MAIN; git checkout --orphan=$B && git push origin HEAD"],
    ["checkout -b with the name attached", "declare -l B; B=MAIN; git checkout -b$B && git push origin HEAD"],
    ["--git-dir=, split by parseGit", "declare -l D; D=/REPO; git --git-dir=$D push origin HEAD"],
    ["a copy into another variable", "declare -l Y; Y=PUSH; Z=$Y; git $Z origin HEAD:main"],
    ["a copy appended to", "declare -l Y; Y=PU; Z=$Y; Z+=SH; git $Z origin HEAD:main"],
    ["a declare copy", "declare -l Y; Y=PUSH; declare Z=$Y; git $Z origin HEAD:main"],
    ["printf -v", "declare -l Y; Y=PUSH; printf -v Z %s \"$Y\"; git $Z origin HEAD:main"],
    ["a destination copied into another variable", "declare -l B; B=MAIN; C=$B; git push origin HEAD:$C"],
  ])("protects a push through %s", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "unknown" }]);
  });

  it.each([
    ["a copy overwritten", "declare -l Y; Y=PUSH; Z=$Y; Z=status; git $Z"],
    ["a destination named in the refspec source only", "declare -l B; B=X; git push origin $B:feature"],
  ])("drops the mark once %s", (_, command) => {
    expect(spellings(command)).not.toContain("bash.merge.git-push-protected");
  });
});

describe("select, getopts, let and (( )), which write without an assignment (TP-1515)", () => {
  it.each([
    ["select", "Y=status; select Y in push; do git $Y origin HEAD:main; done"],
    ["getopts NAME", "Y=status; getopts ab Y; git $Y origin HEAD:main"],
    ["getopts OPTARG", "OPTARG=status; getopts a: Y; git $OPTARG origin HEAD:main"],
    ["getopts OPTIND", "OPTIND=status; getopts a Y; git $OPTIND origin HEAD:main"],
    ["a let with a run-time expression", "Y=status; let \"$E\"; git $Y origin HEAD:main"],
    ["a let that expands a name itself", "Y=status; let '$N=1'; git $Y origin HEAD:main"],
    ["a (( )) with a run-time expression", "Y=status; (( $E )); git $Y origin HEAD:main"],
  ])("leaves the variable unknown after %s, so the push stays protected", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "unknown" }]);
  });

  it.each([
    ["a let of a sum", "Y=status; let Y=1+2; git $Y"],
    ["a let with spaces", "Y=status; let 'Y = 1'; git $Y"],
    ["a let +=", "Y=status; let Y+=1; git $Y"],
    ["a let ++", "Y=status; let Y++; git $Y"],
    ["a let of an octal literal", "Y=status; let Y=010; git $Y"],
    ["a let second expression", "Y=status; let Z=1 Y--; git $Y"],
    ["a (( )) assignment", "Y=status; (( Y=1 )); git $Y"],
    ["a spaced (( )) assignment", "Y=status; (( Y = 1 )); git $Y"],
    ["a (( )) ++", "Y=status; ((Y++)); git $Y"],
    ["a (( )) pre-decrement", "Y=status; (( --Y )); git $Y"],
    ["a (( )) *=", "Y=status; (( Y *= 2 )); git $Y"],
    ["a (( )) >>=", "Y=status; (( Y>>=1 )); git $Y"],
    ["a (( )) element write", "Y=status; (( Y[1]=2 )); git $Y"],
    ["a (( )) after a comma", "Y=status; (( Z=1, Y=2 )); git $Y"],
    ["a (( )) in parentheses", "Y=status; (( (Y=2) + 1 )); git $Y"],
    ["a (( )) whose known reference names it", "N=Y; Y=status; (( $N=1 )); git $Y"],
    ["an arithmetic for", "Y=status; for ((Y=0; Y<1; Y++)); do :; done; git $Y"],
  ])("leaves the variable unknown after %s", (_, command) => {
    expect(gitArgs(command)).toEqual([["$Y"]]);
  });

  it.each([
    ["a let of a literal integer", "Y=status; let Y=1; git $Y"],
    ["a let of zero", "Y=status; let Y=0; git $Y"],
    ["a let of a quoted literal integer", "Y=status; let 'Y=42'; git $Y"],
    ["a later let of a literal integer", "Y=status; let Y++ Y=3; git $Y"],
  ])("leaves the variable unknown even after %s, since the let may not run here", (_, command) => {
    expect(gitArgs(command)).toEqual([["$Y"]]);
  });

  it.each([
    ["piped", "let Y=1 | true"],
    ["after a false &&", "false && let Y=1"],
    ["in an untaken if", "if false; then let Y=1; fi"],
    ["in a while false body", "while false; do let Y=1; done"],
    ["in an uncalled function", "f(){ let Y=1; }"],
    ["in the background", "let Y=1 &"],
    ["under env", "env let Y=1"],
    ["under nice", "nice let Y=1"],
    ["under xargs", "xargs let Y=1"],
    ["after a function named let", "let(){ :;}; let Y=1"],
  ])("still reads a push after a let bash may never run here, %s", (_, command) => {
    expect(spellings(`Y=push; ${command}; git $Y origin HEAD:main`)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["select", "readonly Y=push; select Y in status; do git $Y origin HEAD:main; done"],
    ["getopts", "readonly Y=push; getopts ab Y; git $Y origin HEAD:main"],
    ["getopts OPTARG", "readonly OPTARG=push; getopts a: Y; git $OPTARG origin HEAD:main"],
    ["let", "readonly Y=push; let Y=1; git $Y origin HEAD:main"],
    ["(( ))", "readonly Y=push; (( Y=1 )); git $Y origin HEAD:main"],
  ])("keeps a surely readonly variable's old value after %s", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "main" }]);
  });

  it.each([
    ["select", "Y=status; select Z in push; do git $Y; done"],
    ["getopts", "Y=status; getopts ab Z; git $Y"],
    ["let", "Y=status; let Z=1 Z++; git $Y"],
    ["a let comparison", "Y=status; let 'Y == 1'; git $Y"],
    ["(( ))", "Y=status; (( Z=Y+1 )); git $Y"],
    ["a (( )) comparison", "Y=status; (( Y <= 1 || Y != 2 )); git $Y"],
    ["a nested subshell", "Y=status; ( (Z=1); true ); git $Y"],
    ["a hex literal", "Y=status; (( Z = 0xY1 )); git $Y"],
  ])("keeps a variable %s does not write", (_, command) => {
    expect(gitArgs(command)).toEqual([["status"]]);
  });
});
