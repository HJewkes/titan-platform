import { describe, expect, it, vi } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { tokenize } from "./lexer.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const JOIN = "\\\n";
/** Past this a hook timeout would let the command through; a linear reading takes milliseconds. */
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

function event(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
}

/** Each script is about 64 KB, the most a script is read to, nearly all of it one run of backslash-newlines. */
const SCRIPTS: Array<[string, string]> = [
  ["a (( arithmetic command", `((${JOIN.repeat(32_000)}1))\n`],
  ["a $( ) substitution", `echo "$(${JOIN.repeat(32_000)}true)"\n`],
  ["a plain word", `echo a${JOIN.repeat(32_000)}\n`],
  ["a heredoc of joined lines", `cat <<E\n${`x${JOIN}`.repeat(21_000)}\nE\n`],
];

describe("a long run of backslash-newlines", () => {
  it.each(SCRIPTS)("the hook denies a push after a script holding %s, within the budget", async (_name, script) => {
    const context = { ...nodeContext(HOME, noFs), foldCase: true, readScript: (p: string) => (p === `${REPO}/a.sh` ? script : null) };
    const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };

    const start = performance.now();
    const result = await handle(event("bash a.sh; git push origin HEAD:main"), { PATH: "/usr/bin" }, port);
    const ms = performance.now() - start;

    expect(result.stdout).toContain('"permissionDecision":"deny"');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ["a (( arithmetic command", (run: string) => `((${run}1))`],
    ["a $( ) substitution", (run: string) => `echo "$(${run}true)"`],
    ["a plain word", (run: string) => `echo a${run}`],
    ["a spaced subscript", (run: string) => `Y[ ${run}0 ]=x true`],
  ])("tokenizes %s with work linear in its run of joins", (_name, shape) => {
    // Every join test is a startsWith call, so counting them measures work without a clock a loaded runner skews.
    const work = (joins: number) => {
      const spy = vi.spyOn(String.prototype, "startsWith");
      try {
        tokenize(shape(JOIN.repeat(joins)));
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    const ratio = work(32_000) / work(8_000);

    // Four times the joins is about four times the work when linear and sixteen times when quadratic.
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(6);
  });
});
