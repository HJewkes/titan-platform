import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const ts = new Date("2026-01-02T03:04:05.000Z");
const SCRIPTS: Record<string, string> = { "/home/you/projects/app/r.sh": "hash y=/usr/bin/git\n",
  "/home/you/projects/app/opts.sh": "while getopts ab o; do :; done\nshift $((OPTIND-1))\n",
  "/home/you/projects/app/bg.sh": "sleep 1 &\nwait $!\n",
};
const REBIND_REASON = /does not follow a command name the line rebinds/;

/** Nothing exists on this filesystem unless listed in SCRIPTS. */
function fakeFs(): ReadFs {
  return {
    realpath: (p) => p,
    readHead: (p) => {
      const text = SCRIPTS[p];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    isFile: (p) => p in SCRIPTS,
  };
}

function port(): HookPort {
  return { context: nodeContext(HOME, fakeFs()), now: () => ts, loadDecide: async () => decide };
}

async function answer(command: string): Promise<{ decision: string | null; reason: string; log: string }> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: { command } });
  const result = await handle(input, {}, port());
  const parsed: unknown = result.stdout === "" ? null : JSON.parse(result.stdout);
  const out = HookOutput.safeParse(parsed).data?.hookSpecificOutput;
  return { decision: out?.permissionDecision ?? null, reason: out?.permissionDecisionReason ?? "", log: result.log.join("\n") };
}

const HookOutput = z.object({ hookSpecificOutput: z.object({ permissionDecision: z.string(), permissionDecisionReason: z.string() }) });

const PUSH = "y push origin HEAD:main";

describe("a line that rebinds a command name", () => {
  it.each([
    ["zsh hash NAME=PATH", `hash y=/usr/bin/git; ${PUSH}`],
    ["builtin hash", `builtin hash y=/usr/bin/git; ${PUSH}`],
    ["command hash", `command hash y=/usr/bin/git; ${PUSH}`],
    ["a backslashed hash", `\\hash y=/usr/bin/git; ${PUSH}`],
    ["bash hash -p", `hash -p /usr/bin/git y; ${PUSH}`],
    ["a store into commands", `commands[y]=/usr/bin/git; ${PUSH}`],
    ["an append to commands", `commands+=(y /usr/bin/git); ${PUSH}`],
    ["set -A commands", `set -A commands y /usr/bin/git; ${PUSH}`],
    ["BASH_CMDS", `BASH_CMDS[y]=/usr/bin/git; ${PUSH}`],
    ["functions", "functions[y]='git push origin HEAD:main'; y"],
    ["a hash inside eval", `eval 'hash y=/usr/bin/git'; ${PUSH}`],
    ["a hash inside zsh -c", `zsh -c "hash y=/usr/bin/git; ${PUSH}"`],
    ["a hash through a variable", `H=hash; $H y=/usr/bin/git; ${PUSH}`],
    ["a hash in a sourced script", `source ./r.sh; ${PUSH}`],
    ["a hash in a function body", `f() { hash y=/usr/bin/git; }; f; ${PUSH}`],
    ["a hash in a substitution", `echo $(hash y=/usr/bin/git); ${PUSH}`],
    ["an associative declare with a keyed list", `declare -A BASH_CMDS=([y]=/usr/bin/git); ${PUSH}`],
    ["a local associative declare with a keyed list", `f() { local -A BASH_CMDS=([y]=/usr/bin/git); ${PUSH}; }; f`],
    ["a declare with a keyed list", `declare BASH_CMDS=([y]=/usr/bin/git); ${PUSH}`],
    ["a zsh typeset with a keyed list", `typeset -A commands=([y]=/usr/bin/git); ${PUSH}`],
    ["a keyed append in a list", `declare -A BASH_CMDS=([y]+=/usr/bin/git); ${PUSH}`],
    ["a declare with a plain list", `declare -A commands=(y /usr/bin/git); ${PUSH}`],
    ["a store through zstyle -e", `zstyle -e :z k 'commands[y]=/usr/bin/git'; ${PUSH}`],
  ])("refuses %s", async (_name, command) => {
    const got = await answer(command);
    expect(got.decision).toBe("deny");
    expect(got.reason).toMatch(REBIND_REASON);
    expect(got.log).toContain("bash.oversize");
  });

  it.each([
    ["a bare hash and a lookup", "hash; hash git"],
    ["a hash reset", "hash -r && git status"],
    ["a lookup in arithmetic", "(( $+commands[git] )) && git status"],
    ["a search for the parameter's name", "rg 'commands\\[' src"],
    ["wait on a pid", "wait $!"],
    ["wait on a stored pid", "sleep 1 & pid=$!; wait $pid"],
    ["shift by arithmetic", "shift $((OPTIND-1))"],
    ["print a word", "print $x"],
    ["print a parameter read", "print -l $commands[git]"],
    ["printf with a run-time format", 'printf "$fmt" a'],
    ["declare -p of a rebinding parameter", "declare -p BASH_CMDS"],
    ["typeset -p of a rebinding parameter", "typeset -p commands"],
    ["a getopts script shift", "while getopts ab o; do :; done; shift $((OPTIND-1))"],
    ["a sourced getopts script", "source ./opts.sh"],
    ["a sourced script that waits on a pid", "source ./bg.sh"],
    ["a run script that waits on a pid", "bash ./bg.sh"],
    ["an export of a run-time word", "export $(cmd); git status"],
    ["a declare option the shell rejects", "declare -Q Y=status; git status"],
    ["a gh word that expands to an option", 'gh pr edit 12 "--$X"'],
    ["a gh option word that varies", "gh --$F x pr merge"],
  ])("keeps today's verdict for %s", async (_name, command) => {
    const got = await answer(command);
    expect(got.reason).not.toMatch(REBIND_REASON);
    expect(got.decision).toBeNull();
  });

  it("still reads a plain push as git-push-protected, not as a rebinding", async () => {
    const got = await answer("git push origin HEAD:main");
    expect(got.decision).toBe("deny");
    expect(got.reason).not.toMatch(REBIND_REASON);
    expect(got.log).toContain("bash.merge.git-push-protected");
  });

  // The lexer refuses an assigning expansion on a protected parameter before the walk runs, so these deny with the parse reason.
  it.each([
    ["an assigning expansion", `: \${commands[y]::=/usr/bin/git}; ${PUSH}`],
    ["an assigning expansion in a bare assignment", `X=\${commands[y]::=/usr/bin/git}; ${PUSH}`],
    ["an assigning expansion in a here-string", `cat <<< \${commands[y]::=/usr/bin/git}; ${PUSH}`],
    ["an assigning expansion in a redirect target", `: > \${commands[y]::=/usr/bin/git}; ${PUSH}`],
  ])("refuses %s before the walk", async (_name, command) => {
    const got = await answer(command);
    expect(got.decision).toBe("deny");
  });
});
