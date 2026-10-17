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
const SCRIPTS: Record<string, string> = {
  "/home/you/projects/app/a.sh": "alias y=git\ny push origin HEAD:main\n",
  "/home/you/projects/app/query.sh": "alias pydoc >/dev/null 2>&1 && unalias pydoc\n",
};
const ALIAS_REASON = /does not follow shell aliases a command defines/;

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

const PUSH = "eval 'y push origin HEAD:main'";

describe("a line that defines a shell alias", () => {
  it.each([
    ["alias then eval", `alias y=git; ${PUSH}`],
    ["alias in a substitution", "alias y=git; x=$(y push origin HEAD:main)"],
    ["a store into aliases", `aliases[y]=git; ${PUSH}`],
    ["a global alias", "alias -g P='push origin HEAD:main'; eval 'git P'"],
    ["an alias inside eval", `eval 'alias y=git'; ${PUSH}`],
    ["an alias inside zsh -c", `zsh -c "alias y=git; ${PUSH}"`],
    ["an alias through a variable", `A=alias; $A y=git; ${PUSH}`],
    ["an alias in a sourced script", "source ./a.sh"],
    ["bash expand_aliases on separate lines", "shopt -s expand_aliases\nalias q='git push origin HEAD:main'\nq"],
    ["a brace-expanded alias in eval", "eval {alias,y=echo}"],
    ["builtin alias", `builtin alias y=git; ${PUSH}`],
    ["a backslashed alias", `\\alias y=git; ${PUSH}`],
    ["typeset -A aliases", `typeset -A aliases; ${PUSH}`],
    ["enable -a", `enable -a y; ${PUSH}`],
    ["an alias in a case body", `case x in a) alias y=git;; esac; ${PUSH}`],
    ["a glob command word that may match alias", `ali* y=echo; ${PUSH}`],
    ["a brace-expanded command word", `{alias,y=echo}; ${PUSH}`],
  ])("refuses %s with the alias reason", async (_name, command) => {
    const got = await answer(command);
    expect(got.decision).toBe("deny");
    expect(got.reason).toMatch(ALIAS_REASON);
    expect(got.log).toContain("oversize");
  });

  it.each([
    ["a bare alias listing", "alias"],
    ["an alias query and unalias", "alias g; unalias g"],
    ["a virtualenv-style query", "alias pydoc 2>/dev/null >/dev/null && unalias pydoc || true"],
    ["a grep for the word aliases", "rg aliases packages/"],
    ["an echo of an alias definition", "echo alias y=git"],
    ["a sourced script that only queries", "source ./query.sh"],
    ["a case with glob patterns", "case $t in CC*) i=a;; *) i=b;; esac"],
    ["a case with alternative and quoted patterns", 'case "$o" in finished|detached) echo a;; *"ledger lock"*) sleep 5;; *) echo b;; esac'],
    ["a case inside a substitution", "x=$(case $y in a) echo 1;; *) echo 2;; esac)"],
    ["print of the status", 'print "$?" "${x-unset}"'],
    ["print of the argument count", "print $#"],
    ["printf with = in a format that opens with text", 'printf "b$n=%s " "$(date)"'],
    ["env with a substitution, then an assignment", "env $(env | grep -o '^HOME') DAG_CHECK=1 pnpm dag:check"],
    ["a quoted JSON argument after a run-time word", `"$S/run.sh" '{"a":{"b":1},"c":2}'`],
  ])("keeps today's verdict for %s", async (_name, command) => {
    const got = await answer(command);
    expect(got.reason).not.toMatch(ALIAS_REASON);
    expect(got.decision).toBeNull();
  });

  // Other families may still deny these (an unknown script, an unknown program); the alias reason must not be why.
  it.each([
    ["a script run by a tilde path with a # in an argument", "~/bin/run.sh owner/repo#12"],
    ["a run-time tool with a file and a long option holding =", '"$ESB" src/x.ts --platform=node'],
    ["a comparison on a run-time word", "[[ -n $x && $y == *z* ]]"],
  ])("does not refuse %s as an alias definition", async (_name, command) => {
    const got = await answer(command);
    expect(got.reason).not.toMatch(ALIAS_REASON);
  });

  it("still reads a plain push as git-push-protected, not as an alias definition", async () => {
    const got = await answer("git push origin HEAD:main");
    expect(got.decision).toBe("deny");
    expect(got.reason).not.toMatch(ALIAS_REASON);
    expect(got.log).toContain("bash.merge.git-push-protected");
  });

  // The lexer refuses an assigning expansion on a protected parameter before the walk runs, so these deny with the parse reason.
  it.each([
    ["an assigning expansion", `: \${aliases[y]::=git}; ${PUSH}`],
    ["an assigning expansion in a bare assignment", `X=\${aliases[y]::=git}; ${PUSH}`],
    ["an assigning expansion in a here-string", `cat <<< \${aliases[y]::=git}; ${PUSH}`],
    ["an assigning expansion in a redirect target", `: > \${aliases[y]::=git}; ${PUSH}`],
  ])("refuses %s before the walk", async (_name, command) => {
    const got = await answer(command);
    expect(got.decision).toBe("deny");
  });
});
