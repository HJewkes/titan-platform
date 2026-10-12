import { describe, expect, it } from "vitest";
import type { ReadFs } from "../context.js";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import type { HookPort } from "../hook.js";
import { handle } from "../hook.js";
import { extractCommands } from "./commands.js";
import { ParseError, tokenize } from "./lexer.js";

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
    ["a newline in the subscript while a heredoc waits", "cat <<E >/dev/null; a[\n]=1; git push origin HEAD:main\nE"],
    ["a newline in the subscript after a heredoc and &&", "cat <<E >/dev/null && a[\n]=1; git push origin HEAD:main\nE"],
    ["a newline in the subscript after : <<E;", ": <<E; a[\n]=1; git push origin HEAD:main\nE"],
    ["a newline in the subscript after <<-E", ": <<-E; a[\n]=1; git push origin HEAD:main\n\tE"],
    ["a newline in the subscript after a quoted heredoc", ': <<"E"; a[\n]=1; git push origin HEAD:main\nE'],
    ["a newline in a subscript after an assignment while a heredoc waits", ": <<E; b=1 a[\n]=1; git push origin HEAD:main\nE"],
    ["a newline in a subscript after a redirect while a heredoc waits", ": <<E; 2>/dev/null a[\n]=1; git push origin HEAD:main\nE"],
    ["a newline in a subscript with no = while a heredoc waits", ": <<E; x[\n]; git push origin HEAD:main\nE"],
    ["a newline in a subscript in a subshell while a heredoc waits", "(: <<E; a[\n]=1; git push origin HEAD:main\nE\n)"],
    ["a newline in a subscript in a function body while a heredoc waits", "f() { : <<E; a[\n]=1; git push origin HEAD:main\nE\n}; f"],
    ["a (( opened in the subscript, then a newline while a heredoc waits", ": <<E; a[ ((1\n)) ]=1; git push origin HEAD:main\nE"],
    ["after ((, a (( opened in the subscript, then a newline while a heredoc waits", ": <<E; ((1)); a[ ((1\n)) ]=1; git push origin HEAD:main\nE"],
    ["a nested [ in a (( opened in the subscript, then a newline while a heredoc waits", ": <<E; a[ ((b[ 1\n)) ]=1; git push origin HEAD:main\nE"],
    ["a (( opened in the subscript holding a heredoc opener", "a[ ((1 <<E )) ]=1\ngit push origin HEAD:main\nE"],
    ["a (( from one span still open as a later span takes a newline", ": <<E; a[ ((1 ]=1 b[\n]=1 c[ )) ]; git push origin HEAD:main\nE"],
    ["a (( from one span still open as a later spaced span takes a newline", "cat <<E; a[ ((1 ]=1 b[ \n ]=1 c[ )) ]; git push origin HEAD:main\nE"],
    ["a (( from one span still open as a later span takes a CRLF", ": <<E; a[ ((1 ]=1 b[\r\n]=1 c[ )) ]; git push origin HEAD:main\nE"],
    ["a (( from one span still open as a later span opens its own ((", ": <<E; a[ ((b[ 1 ] ]=1 b[ ((2\n)) ]=1 c[ )) ]; git push origin HEAD:main\nE"],
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
    ["a shift in a subscript inside arithmetic", "((a[1<<2])); echo ok"],
    ["a spaced shift in a subscript inside arithmetic, then a comment", "(( a[ 1 << 2 ] )) # c"],
    ["a heredoc beside a closed subscript", "cat <<E; a[0]=1\nbody\nE"],
    ["a heredoc then a subscript spanning lines", "cat <<E\nbody\nE\na[\n0]=1"],
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

/** Bash runs `echo HIDDEN` in each; the guard must refuse the line or read that command, never hide it. */
function refusesOrShowsHidden(command: string): boolean {
  try {
    return extractCommands(command).some((c) => c.name === "echo" && c.args[0]?.value === "HIDDEN");
  } catch (error) {
    return error instanceof ParseError;
  }
}

describe("backquote spans in a subscript bash may join", () => {
  it.each([
    ["after ((, a } inside backquotes before their close", "declare -A a; ((1)); a[ `[]}]` # ]=x; echo HIDDEN"],
    ["with no prefix, a } inside backquotes before their close", "a[ `[]}]` # ]; echo HIDDEN"],
    ["after a redirect, a } inside backquotes before their close", "2>/dev/null a[ `[]}]` # ]=x; echo HIDDEN"],
    ["in a subshell, a } inside backquotes before their close", "(a[ `[]}]` # ]=x; echo HIDDEN)"],
    ["a } inside backquotes before a heredoc opener", "a[ `[]}]` <<E ]=1\necho HIDDEN\nE"],
    ["with no prefix, a ] in a second adjacent backquote", "a[ `[]``]` # ]; echo HIDDEN"],
    ["after ((, a ] in a second adjacent backquote", "((1)); a[ `[]``]` # ]=x; echo HIDDEN"],
    ["after a redirect, a ] in a second adjacent backquote", "2>/dev/null a[ `[]``]` # ]=x; echo HIDDEN"],
    ["in a subshell, a ] in a second adjacent backquote", "(a[ `[]``]` # ]=x; echo HIDDEN)"],
    ["a ] in a second adjacent backquote before a heredoc opener", "a[ `[]``]` <<E ]=1\necho HIDDEN\nE"],
    ["after [[ ]], a ] in a second adjacent backquote", "[[ 1 ]]; a[ `[]``]` # ]; echo HIDDEN"],
    ["after &&, a ] in a second adjacent backquote", "true && a[ `[]``]` # ]; echo HIDDEN"],
    ["after a heredoc, a ] in a second adjacent backquote", "cat <<'E' >/dev/null\n`x`\nE\na[ `[]``]` # ]; echo HIDDEN"],
  ])("refuses or shows the command %s", (_scenario, command) => {
    expect(refusesOrShowsHidden(command)).toBe(true);
  });
});

/**
 * Past this a hook timeout would let the command through. It is a backstop a loaded runner stays far under; the work
 * ratio below is what tells linear from quadratic.
 */
const BUDGET_MS = 2500;

/** Far above the characters a linear scan reads per opener, far below the source length a quadratic one reads. */
const WORK_PER_OPENER = 200;

class WorkCapExceeded extends Error {}

/** Calls `read` with `String.prototype.charAt`, which the span scan reads each character through, counted and capped. */
function countCharAt(read: () => unknown, cap: number): number {
  const original = String.prototype.charAt;
  let calls = 0;
  String.prototype.charAt = function (this: string, pos: number) {
    if (++calls > cap) throw new WorkCapExceeded(`more than ${cap} charAt calls`);
    return original.call(this, pos);
  };
  try {
    read();
  } catch (error) {
    // A refusal ends the read as it would in the hook; only the cap means the work ran away.
    if (error instanceof WorkCapExceeded) throw error;
  } finally {
    String.prototype.charAt = original;
  }
  return calls;
}

/** Each shape's span, repeated inside one argument-position subscript. */
const SPAN_SHAPES: Array<[string, string]> = [
  ["$${ openers, each a bare { to bash", "$${x["],
  ["nested ${ openers", "${x["],
  ["closed ${ spans", "${x[0]}"],
  ["backquote spans", "`[]`"],
];

const spanScript = (span: string, count: number) => `echo a[ ${span.repeat(count)} ]\n`;

async function timedScriptDecision(script: string): Promise<{ decision: string | null; ms: number }> {
  const context = { ...nodeContext(HOME, noFs), foldCase: true, readScript: (p: string) => (p === `${HOME}/app/a.sh` ? script : null) };
  const scriptPort: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command: "bash a.sh; git push origin HEAD:main" } });
  const start = performance.now();
  const { stdout } = await handle(input, { PATH: "/usr/bin" }, scriptPort);
  return { decision: stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout, ms: performance.now() - start };
}

describe("a subscript holding many span openers", () => {
  it.each(SPAN_SHAPES)("the hook denies a push after a 64 KB script of %s, within the budget", async (_name, span) => {
    const script = spanScript(span, Math.floor(64_000 / span.length));

    const { decision, ms } = await timedScriptDecision(script);

    expect(decision).toBe("deny");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it.each(SPAN_SHAPES)("tokenizes %s with work linear in the openers", (_name, span) => {
    // A count of characters read measures work without a clock a loaded runner skews.
    const work = (openers: number) => countCharAt(() => tokenize(spanScript(span, openers)), openers * WORK_PER_OPENER);

    // Sizes no other row uses, since each source's bracket scan is cached and a cached one costs nothing.
    const ratio = work(12_000) / work(3_000);

    // Four times the openers is about four times the work when linear and sixteen times when quadratic.
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(6);
  });
});
