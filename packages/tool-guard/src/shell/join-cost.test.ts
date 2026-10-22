import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { cpuBudgetIt } from "../test-support/cpu-budget.js";
import { countWork, expectWorkPerChar } from "../test-support/work-count.js";
import { tokenize } from "./lexer.js";
import { ParseError } from "./parse-error.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const JOIN = "\\\n";
/**
 * Past this thread-CPU time a hook timeout would let the command through; a linear reading takes milliseconds. The
 * bench checks it, for the work a count cannot see, such as indexing a string one character at a time; under pnpm test
 * the hook rows count work instead, which load on the runner cannot move (TP-2785, TP-4047).
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
 * The most a linear reading of any shape below was measured to read per source character is 34 characters, for
 * unclosed subscripts and for one long name before many brackets; this leaves about 30% headroom. A quadratic reads
 * thousands per character.
 */
const WORK_PER_CHAR = 45;

/**
 * The same through the whole hook, which reads the script more than once: the most measured is 175 characters a
 * character, for unclosed subscripts. A rescan per command of even a sixty-fourth of the script would be 1 000.
 */
const HOOK_WORK_PER_CHAR = 250;

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
  [
    "commands each with an unclosed subscript",
    (n) => `${"a[;".repeat(n)}\n`,
    21_000,
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

async function hookStdout(script: string): Promise<string> {
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
  const result = await handle(
    event("bash a.sh; git push origin HEAD:main"),
    { PATH: "/usr/bin" },
    port
  );
  return result.stdout;
}

describe("a script of many subscripts", () => {
  cpuBudgetIt.each(atFullSize(SUBSCRIPTS))(
    "the hook denies a push after %s, within the budget",
    BUDGET_MS,
    async (_name, script) => {
      let stdout = "";

      await expectWorkPerChar(async () => (stdout = await hookStdout(script)), script.length, HOOK_WORK_PER_CHAR);

      expect(stdout).toContain('"permissionDecision":"deny"');
    }
  );
});

describe("a long run of backslash-newlines", () => {
  cpuBudgetIt.each(atFullSize(SCRIPTS))(
    "the hook denies a push after a script holding %s, within the budget",
    BUDGET_MS,
    async (_name, script) => {
      let stdout = "";

      await expectWorkPerChar(async () => (stdout = await hookStdout(script)), script.length, HOOK_WORK_PER_CHAR);

      expect(stdout).toContain('"permissionDecision":"deny"');
    }
  );
});

describe("tokenizing a 64 KB script", () => {
  it.each([...SCRIPTS, ...SUBSCRIPTS, SPACED_SUBSCRIPT])(
    "reads %s with work linear in its size",
    async (_name, script, n) => {
      const work = (size: number) => {
        // The leading space keeps this source apart from the hook rows' copy, which the per-source caches would hold.
        const src = ` ${script(size)}`;
        return countWork(
          () => tokenizeOrRefuse(src),
          src.length * WORK_PER_CHAR
        );
      };

      const ratio = (await work(n)) / (await work(n / 4));

      // Every shape measures 3.99 to 4.00. Four times the input is sixteen times the work when quadratic, and
      // already 4.6 times when the work grows as n^1.1.
      expect(ratio).toBeGreaterThan(3.5);
      expect(ratio).toBeLessThan(4.5);
    }
  );
});
