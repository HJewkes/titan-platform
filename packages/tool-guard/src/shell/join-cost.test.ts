import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { tokenize } from "./lexer.js";
import { ParseError } from "./parse-error.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const JOIN = "\\\n";
/**
 * Only a backstop: the counted-work rows below are what catch a quadratic. Claude Code kills the hook at 5 s
 * (`cli.ts`), letting the command through, and a loaded runner took 1029 ms on a row here (tp#1464, run 38435978632).
 */
const HOOK_BACKSTOP_MS = 4000;

const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

/** About 4x the most a linear reading of any shape below spends per source character: 21, for unclosed subscripts. */
const WORK_PER_CHAR = 84;

class WorkCapExceeded extends Error {}

/**
 * Calls `read` with every `startsWith` (join tests), `RegExp.prototype.test` (assignment and name checks) and
 * `Array.prototype.push` (bracket pairing) counted, stopping it once the count passes `cap`. Each guarded memo
 * stops one of these from repeating per bracket or per join, so counting them measures work without a clock.
 */
function countWork(read: () => unknown, cap: number): number {
  const startsWith = String.prototype.startsWith;
  const test = RegExp.prototype.test;
  const push = Array.prototype.push;
  let calls = 0;
  const count = () => {
    if (++calls > cap) throw new WorkCapExceeded(`more than ${cap} counted calls`);
  };
  String.prototype.startsWith = function (this: string, ...args: Parameters<string["startsWith"]>) {
    count();
    return startsWith.apply(this, args);
  };
  RegExp.prototype.test = function (this: RegExp, s: string) {
    count();
    return test.call(this, s);
  };
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    count();
    return push.apply(this, items);
  };
  try {
    read();
    return calls;
  } finally {
    String.prototype.startsWith = startsWith;
    RegExp.prototype.test = test;
    Array.prototype.push = push;
  }
}

/** A refused line is still a deny, so a `ParseError` ends the reading as the hook would. */
function tokenizeOrRefuse(src: string): void {
  try {
    tokenize(src);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
  }
}

function event(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
}

type Shape = [name: string, script: (n: number) => string, n: number];

/** At `n`, each script is about 64 KB, the most a script is read to, nearly all of it one run of backslash-newlines. */
const SCRIPTS: Shape[] = [
  ["a (( arithmetic command", (n) => `((${JOIN.repeat(n)}1))\n`, 32_000],
  ["a $( ) substitution", (n) => `echo "$(${JOIN.repeat(n)}true)"\n`, 32_000],
  ["a plain word", (n) => `echo a${JOIN.repeat(n)}\n`, 32_000],
  ["a heredoc of joined lines", (n) => `cat <<E\n${`x${JOIN}`.repeat(n)}\nE\n`, 21_000],
];

/** At `n`, each script is about 64 KB of `[`s, every one of which asks whether bash reads a subscript assignment there. */
const SUBSCRIPTS: Shape[] = [
  ["assignments each followed by a join", (n) => `${`a[0]=1 ${JOIN}`.repeat(n)}\n`, 7_000],
  ["commands each with a joined subscript", (n) => `${`a${JOIN}[0]=1;`.repeat(n)}\n`, 7_000],
  ["assignments with no joins", (n) => `${"a[0]=1 ".repeat(n)}\n`, 9_000],
  // Half size: handling 21 000 commands of any kind costs a few hundred ms; a scan per bracket would still cost seconds.
  ["commands each with an unclosed subscript", (n) => `${"a[;".repeat(n)}\n`, 10_500],
  ["one long name before many brackets", (n) => `${"a".repeat(n)}${"[".repeat(n)}\n`, 32_000],
];

const SPACED_SUBSCRIPT: Shape = ["a spaced subscript", (n) => `Y[ ${JOIN.repeat(n)}0 ]=x true`, 32_000];

const atFullSize = (shapes: Shape[]) => shapes.map(([name, script, n]): [string, string] => [name, script(n)]);

async function timedHookStdout(script: string): Promise<{ stdout: string; ms: number }> {
  const context = { ...nodeContext(HOME, noFs), foldCase: true, readScript: (p: string) => (p === `${REPO}/a.sh` ? script : null) };
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const start = performance.now();
  const result = await handle(event("bash a.sh; git push origin HEAD:main"), { PATH: "/usr/bin" }, port);
  return { stdout: result.stdout, ms: performance.now() - start };
}

describe("a script of many subscripts", () => {
  it.each(atFullSize(SUBSCRIPTS))("the hook denies a push after %s, within the hook's timeout", async (_name, script) => {
    const { stdout, ms } = await timedHookStdout(script);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(ms).toBeLessThan(HOOK_BACKSTOP_MS);
  });
});

describe("a long run of backslash-newlines", () => {
  it.each(atFullSize(SCRIPTS))(
    "the hook denies a push after a script holding %s, within the hook's timeout",
    async (_name, script) => {
      const { stdout, ms } = await timedHookStdout(script);

      expect(stdout).toContain('"permissionDecision":"deny"');
      expect(ms).toBeLessThan(HOOK_BACKSTOP_MS);
    },
  );
});

describe("tokenizing a 64 KB script", () => {
  it.each([...SCRIPTS, ...SUBSCRIPTS, SPACED_SUBSCRIPT])("reads %s with work linear in its size", (_name, script, n) => {
    const work = (size: number) => {
      // The leading space keeps this source apart from the hook rows' copy, which the per-source caches would hold.
      const src = ` ${script(size)}`;
      return countWork(() => tokenizeOrRefuse(src), src.length * WORK_PER_CHAR);
    };

    const ratio = work(n) / work(n / 4);

    // Four times the input is about four times the work when linear and sixteen times when quadratic.
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(6);
  });
});
