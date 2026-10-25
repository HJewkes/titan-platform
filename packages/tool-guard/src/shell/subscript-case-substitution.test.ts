import { describe, expect, it } from "vitest";
import type { ReadFs } from "../context.js";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import type { HookPort } from "../hook.js";
import { handle } from "../hook.js";
import { cpuBudgetIt } from "../test-support/cpu-budget.js";

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

describe("a $( ) in a subscript whose ) a case pattern or heredoc body holds", () => {
  // Bash 5.3 runs the command after each `#`: the `)` inside the body does not end the `$(`, so the `#` sits inside the subscript.
  it.each([
    ["a case pattern, inside a subshell", "( ((1)); a[ $(case x in x) esac | : ] ) # ]=1; git push origin HEAD:main )"],
    ["a case pattern, with no subshell", "((1)); a[ $(case x in x) esac | : ] ) # ]=1; git push origin HEAD:main"],
    ["a heredoc body", "( ((1)); a[ $(cat <<E\n)\nE\n: ] ) # ]=1; git push origin HEAD:main )"],
    ["a case pattern one $( down", "declare -A a; ((1)); a[ $(echo $(case x in x) esac) : ] ) # ]=1; git push origin HEAD:main"],
    ["a case pattern, ahead of gh pr merge", "( ((1)); a[ $(case x in x) esac | : ] ) # ]=1; gh pr merge 1 )"],
    ["a case word split after ca by a line continuation", "( ((1)); a[ $(ca\\\nse x in x) esac | : ] ) # ]=1; git push origin HEAD:main )"],
    ["a case word split after cas by a line continuation", "( ((1)); a[ $(cas\\\ne x in x) esac | : ] ) # ]=1; git push origin HEAD:main )"],
    ["a heredoc opener split by a line continuation", "( ((1)); a[ $(cat <\\\n<E\n)\nE\n: ] ) # ]=1; git push origin HEAD:main )"],
  ])("denies %s", async (_name, command) => {
    expect(await decisionOf(command)).toBe("deny");
  });

  it.each([
    ["a word ending in case", "((1)); a[$(showcase 'x')]=x # c"],
    ["a word starting with case", "((1)); a[$(cases 'x')]=x # c"],
    ["a shift inside $(( ))", "((1)); a[$((1<<2))]=x # c"],
    ["a plain $( )", "((1)); a[$(f)]=x # c"],
    ["a case statement around the subscript", "case $x in a) arr[$(f)]=x ;; esac # c"],
  ])("passes %s", async (_name, command) => {
    expect(await decisionOf(command)).toBeNull();
  });
});

const BUDGET_MS = 2500;
const CASE_SPAN = "$(case x in x) esac) ";

async function scriptDecision(script: string): Promise<string | null> {
  const context = { ...nodeContext(HOME, noFs), foldCase: true, readScript: (p: string) => (p === `${HOME}/app/a.sh` ? script : null) };
  const scriptPort: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command: "bash a.sh; git push origin HEAD:main" } });
  const { stdout } = await handle(input, { PATH: "/usr/bin" }, scriptPort);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

describe("a subscript holding many case spans", () => {
  cpuBudgetIt("the hook denies a push after a 64 KB script of them, within the budget", BUDGET_MS, async () => {
    const script = `echo a[ ${CASE_SPAN.repeat(Math.floor(64_000 / CASE_SPAN.length))}]\n`;

    expect(await scriptDecision(script)).toBe("deny");
  });
});
