import { describe, expect, it } from "vitest";
import type { ReadFs } from "../context.js";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import type { HookPort } from "../hook.js";
import { handle } from "../hook.js";

const HOME = "/home/you";
const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function decisionOf(command: string): Promise<string | null> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

describe("a subscript bash may join but the guard splits", () => {
  it.each([
    ["after ((", "declare -A a; ((1)); a[ # ]=x; git push origin HEAD:main"],
    ["after [[ ]]", "declare -A a; [[ 1 ]]; a[ # ]=x; git push origin HEAD:main"],
    ["after case … esac", "declare -A a; case 1 in 1) :;; esac; a[ # ]=x; git push origin HEAD:main"],
    ["inside a case clause", "case 1 in 1) a[ # ]=x; git push origin HEAD:main;; esac"],
    ["in a += form", "((1)); a[ # ]+=x; git push origin HEAD:main"],
    ["with the push on the next line", "((1)); a[ # ]=x\ngit push origin HEAD:main"],
    ["holding a heredoc opener", "((1)); a[ <<E ]=x\ngit push origin HEAD:main\nE"],
    ["placeable with no = after the ]", "x[ # ]; git push origin HEAD:main"],
    ["ahead of gh pr merge", "((1)); a[ # ]=x; gh pr merge 1"],
    ["split by bash, a ${ in the comment", "((1)); echo a[ # x ${\ngit push origin HEAD:main\n}]"],
    ["split by bash, a double quote in the comment", '((1)); echo a[ # it"s\ngit push origin HEAD:main\n"]'],
    ["split by bash, an ANSI-C quote in the comment", "((1)); echo a[ # x $'\ngit push origin HEAD:main\n']"],
    ["split by bash after [[ ]]", "[[ 1 ]]; echo a[ # x ${\ngit push origin HEAD:main\n}]"],
    ["split by bash after case … esac", "case 1 in 1) :;; esac; echo a[ # x ${\ngit push origin HEAD:main\n}]"],
    ["split by bash after a heredoc", "cat <<E\nx\nE\necho a[ # x ${\ngit push origin HEAD:main\n}]"],
    ["split by bash, a heredoc opener in the span", "((1)); echo a[ <<E ${\ngit push origin HEAD:main\n}]\nE"],
    ["joined by bash, a ${ funsub after the #", "x[ # ${\ngit push origin HEAD:main\n}]"],
    ["joined by bash, a ${ funsub after a heredoc opener", "x[ <<E ${\ngit push origin HEAD:main\n}]\nE"],
    ["after ((, a [ inside ${ } in the subscript", "((1)); a[ ${x:-[} # ]; git push origin HEAD:main"],
    ["after [[ ]], a [ inside $( ) in the subscript", "[[ 1 ]]; a[ $(echo [) # ]; git push origin HEAD:main"],
    ["after a heredoc, a [ inside backquotes in the subscript", "cat <<E >/dev/null\nE\na[ `echo [` # ]; git push origin HEAD:main"],
    ["with no prefix, a [ inside $( ) in the subscript", "a[ $(echo [) # ]; git push origin HEAD:main"],
    ["after an assignment, a [ inside $( ) before a heredoc opener", "b=1 a[ $(echo [) <<E ]=1\ngit push origin HEAD:main\nE"],
    ["after ((, a [ inside $( ) before a heredoc opener", "((1)); a[ $(echo [) <<E ]=1\ngit push origin HEAD:main\nE"],
    ["split by bash, a backquote in the comment", "((1)); echo a[ # x `\ngit push origin HEAD:main\n`]"],
    ["after a stderr redirect", "2>/dev/null a[ # ]=x; git push origin HEAD:main"],
    ["after a stdout redirect, no =", ">/dev/null a[ # ]; git push origin HEAD:main"],
    ["after an assignment and a redirect", "b=1 >/dev/null a[ # ]=x; git push origin HEAD:main"],
    ["after a redirect, a heredoc opener", "2>/dev/null a[ <<E ]=x\ngit push origin HEAD:main\nE"],
    ["after coproc", "coproc a[ # ]=x; git push origin HEAD:main"],
    ["after coproc, no =", "coproc a[ # ]; git push origin HEAD:main"],
    ["after time -p", "time -p a[ # ]=x; git push origin HEAD:main"],
    ["inside a subshell", "(a[ # ]=x; git push origin HEAD:main)"],
    ["inside a spaced subshell", "( a[ # ]=x; git push origin HEAD:main)"],
    ["inside a subshell, a heredoc opener", "(a[ <<E ]=x\ngit push origin HEAD:main\nE\n)"],
    ["inside a function body", "f() { a[ # ]=x; git push origin HEAD:main; }; f"],
    ["inside a function keyword body", "function f { a[ # ]=x; git push origin HEAD:main; }; f"],
    ["in an argument position", "echo a[ # git push origin HEAD:main ]"],
    ["after ((, a ${ with an unbalanced [", "((1)); a[ ${x:-[} ]=1 # ]; git push origin HEAD:main"],
    ["after ((, a ${ with a bare { inside", "((1)); a[ ${x:-{[} # ]; git push origin HEAD:main"],
  ])("denies a push hidden behind # %s", async (_scenario, command) => {
    expect(await decisionOf(command)).toBe("deny");
  });

  it.each([
    ["arithmetic then a plain subscript", "((i++)); a[$i]=x; echo ok"],
    ["a test then a subscript", "[[ -n $x ]] && a[0]=y"],
    ["a real comment after a command", "((1)); echo hi # git push origin HEAD:main"],
    ["arithmetic then an append by length and a comment", "((n++)); arr[${#arr[@]}]=$n # append"],
    ["a test then an append by length and a comment", "[[ -n $x ]] && arr[${#arr[@]}]=$x # add"],
    ["an arithmetic for loop filling an array", "for ((i=0;i<3;i++)); do a[${#a[@]}]=$i; done # fill"],
    ["a case clause appending", "case $x in a) arr[${#arr[@]}]=x ;; esac # c"],
    ["a heredoc then an append", "cat <<EOF\nhi\nEOF\narr[${#arr[@]}]=x # c"],
    ["an append then a heredoc on a later line", "((1)); a[${#a[@]}]=x\ncat <<EOF\nbody\nEOF"],
    ["an element-indexed subscript and a comment", "((1)); a[${b[0]}]=x # c"],
    ["an appending += and a comment", "((1)); a[${#a[@]}]+=x # c"],
    ["a backquoted subscript and a comment", "((1)); a[`echo 1`]=x # c"],
    ["arithmetic then a substituted subscript and a comment", "((i++)); a[$(f)]=x # git push origin HEAD:main"],
    ["arithmetic then an append by length", "((n++)); a[${#a[@]}]=x; echo ok"],
    ["arithmetic then a comment after a closed subscript", "((1)); echo a[0] # git push origin HEAD:main"],
    ["a test then a spaced subscript argument", "[[ -n $x ]]; echo a[ $x ]"],
  ])("passes %s", async (_scenario, command) => {
    expect(await decisionOf(command)).toBeNull();
  });
});
