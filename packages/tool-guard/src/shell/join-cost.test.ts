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
 * Past this thread-CPU time a hook timeout would let the command through; a linear reading takes milliseconds. It
 * also backs the counted rows below for the work they cannot count, such as indexing a string one character at a time.
 */
const BUDGET_MS = 1000;

const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

/**
 * The most a linear reading of any shape below was measured to spend per source character is 23 counted calls, for
 * unclosed subscripts and for one long name before many brackets; this leaves about 30% headroom. A quadratic spends
 * thousands per character.
 */
const WORK_PER_CHAR = 30;

class WorkCapExceeded extends Error {}

/**
 * The string and pattern primitives the lexer reads its source through. Every guarded memo stops one of these from
 * repeating per bracket or per join, so a quadratic that slips a memo shows up in their count. `push` is here because
 * the bracket scan indexes characters directly: the `[`s it pushes are the only calls a rescan per bracket repeats.
 */
const COUNTED: Array<[object, string]> = [
  ...[
    "startsWith",
    "endsWith",
    "includes",
    "indexOf",
    "lastIndexOf",
    "slice",
    "charAt",
    "charCodeAt",
    "codePointAt",
  ].map((key): [object, string] => [String.prototype, key]),
  [RegExp.prototype, "test"],
  [RegExp.prototype, "exec"],
  [Array.prototype, "push"],
];

/** Calls `read` with every `COUNTED` primitive counted, stopping it once the count passes `cap`. */
function countWork(read: () => unknown, cap: number): number {
  let calls = 0;
  const originals = COUNTED.map(([proto, key]) =>
    Object.getOwnPropertyDescriptor(proto, key)
  );
  COUNTED.forEach(([proto, key], i) => {
    const original: unknown = originals[i]?.value;
    if (typeof original !== "function") throw new Error(`no ${key} to count`);
    Object.defineProperty(proto, key, {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: unknown[]): unknown {
        if (++calls > cap)
          throw new WorkCapExceeded(`more than ${cap} counted calls`);
        return Reflect.apply(original, this, args);
      },
    });
  });
  try {
    read();
    return calls;
  } finally {
    COUNTED.forEach(([proto, key], i) =>
      Object.defineProperty(proto, key, originals[i] ?? {})
    );
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
  return JSON.stringify({
    tool_name: "Bash",
    session_id: "s",
    tool_use_id: "t",
    cwd: REPO,
    tool_input: { command },
  });
}

type Shape = [name: string, script: (n: number) => string, n: number];

/** At `n`, each script is about 64 KB, the most a script is read to, nearly all of it one run of backslash-newlines. */
const SCRIPTS: Shape[] = [
  ["a (( arithmetic command", (n) => `((${JOIN.repeat(n)}1))\n`, 32_000],
  ["a $( ) substitution", (n) => `echo "$(${JOIN.repeat(n)}true)"\n`, 32_000],
  ["a plain word", (n) => `echo a${JOIN.repeat(n)}\n`, 32_000],
  [
    "a heredoc of joined lines",
    (n) => `cat <<E\n${`x${JOIN}`.repeat(n)}\nE\n`,
    21_000,
  ],
];

/** At `n`, each script is about 64 KB of `[`s, every one of which asks whether bash reads a subscript assignment there. */
const SUBSCRIPTS: Shape[] = [
  [
    "assignments each followed by a join",
    (n) => `${`a[0]=1 ${JOIN}`.repeat(n)}\n`,
    7_000,
  ],
  [
    "commands each with a joined subscript",
    (n) => `${`a${JOIN}[0]=1;`.repeat(n)}\n`,
    7_000,
  ],
  ["assignments with no joins", (n) => `${"a[0]=1 ".repeat(n)}\n`, 9_000],
  // Half size: handling 21 000 commands of any kind costs a few hundred ms; a scan per bracket would still cost seconds.
  [
    "commands each with an unclosed subscript",
    (n) => `${"a[;".repeat(n)}\n`,
    10_500,
  ],
  [
    "one long name before many brackets",
    (n) => `${"a".repeat(n)}${"[".repeat(n)}\n`,
    32_000,
  ],
];

const SPACED_SUBSCRIPT: Shape = [
  "a spaced subscript",
  (n) => `Y[ ${JOIN.repeat(n)}0 ]=x true`,
  32_000,
];

const atFullSize = (shapes: Shape[]) =>
  shapes.map(([name, script, n]): [string, string] => [name, script(n)]);

/**
 * Times the hook in this thread's CPU, not the wall clock: in a full run the worker shares the runner's cores with
 * other test files, and the time it waits for one says nothing about the work the hook does.
 */
async function timedHookStdout(
  script: string
): Promise<{ stdout: string; cpuMs: number }> {
  const context = {
    ...nodeContext(HOME, noFs),
    foldCase: true,
    readScript: (p: string) => (p === `${REPO}/a.sh` ? script : null),
  };
  const port: HookPort = {
    context,
    now: () => new Date(0),
    loadDecide: async () => decide,
  };
  const start = process.threadCpuUsage();
  const result = await handle(
    event("bash a.sh; git push origin HEAD:main"),
    { PATH: "/usr/bin" },
    port
  );
  const { user, system } = process.threadCpuUsage(start);
  return { stdout: result.stdout, cpuMs: (user + system) / 1000 };
}

describe("a script of many subscripts", () => {
  it.each(atFullSize(SUBSCRIPTS))(
    "the hook denies a push after %s, within the budget",
    async (_name, script) => {
      const { stdout, cpuMs } = await timedHookStdout(script);

      expect(stdout).toContain('"permissionDecision":"deny"');
      expect(cpuMs).toBeLessThan(BUDGET_MS);
    }
  );
});

describe("a long run of backslash-newlines", () => {
  it.each(atFullSize(SCRIPTS))(
    "the hook denies a push after a script holding %s, within the budget",
    async (_name, script) => {
      const { stdout, cpuMs } = await timedHookStdout(script);

      expect(stdout).toContain('"permissionDecision":"deny"');
      expect(cpuMs).toBeLessThan(BUDGET_MS);
    }
  );
});

describe("tokenizing a 64 KB script", () => {
  it.each([...SCRIPTS, ...SUBSCRIPTS, SPACED_SUBSCRIPT])(
    "reads %s with work linear in its size",
    (_name, script, n) => {
      const work = (size: number) => {
        // The leading space keeps this source apart from the hook rows' copy, which the per-source caches would hold.
        const src = ` ${script(size)}`;
        return countWork(
          () => tokenizeOrRefuse(src),
          src.length * WORK_PER_CHAR
        );
      };

      const ratio = work(n) / work(n / 4);

      // Every shape measures 3.99 to 4.00. Four times the input is sixteen times the work when quadratic, and
      // already 4.6 times when the work grows as n^1.1.
      expect(ratio).toBeGreaterThan(3.5);
      expect(ratio).toBeLessThan(4.5);
    }
  );
});
