import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { tokenize } from "./lexer.js";
import { ParseError } from "./parse-error.js";
import { EXEC_HOOKS, PROTECTED } from "./protected-params.js";

const HOME = "/home/you";
const PUSH = "git push origin HEAD:feat";

const port: HookPort = {
  context: nodeContext(HOME, { realpath: (p) => p, readHead: () => "feat", isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

const input = (command: string) => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });

async function handled(command: string): Promise<"deny" | "pass"> {
  const { stdout } = await handle(input(command), {}, port);
  return stdout === "" ? "pass" : "deny";
}

const REFUSED = [
  ["PROMPT_COMMAND with ::=", ": ${PROMPT_COMMAND::=x}"],
  ["PROMPT_COMMAND with :=", ": ${PROMPT_COMMAND:=x}"],
  ["a PROMPT_COMMAND element", ": ${PROMPT_COMMAND[0]=x}"],
  ["PS1", ": ${PS1::=x}"],
  ["the zsh prompt", ": ${prompt::=x}"],
  ["SPROMPT", ": ${SPROMPT:=x}"],
  ["chpwd_functions as an array", ": ${(A)chpwd_functions::=f}"],
  ["precmd_functions", ": ${precmd_functions::=f}"],
  ["preexec_functions", ": ${preexec_functions::=f}"],
  ["zshexit_functions", ": ${zshexit_functions::=f}"],
  ["BASH_ENV", ": ${BASH_ENV:=/x}"],
  ["ENV", ": ${ENV:=/x}"],
  ["ZDOTDIR", ": ${ZDOTDIR::=/x}"],
  ["HOME", ": ${HOME::=/x}"],
  ["SHELLOPTS", ": ${SHELLOPTS:=xtrace}"],
  ["BASHOPTS", ": ${BASHOPTS:=x}"],
  ["FPATH", ": ${FPATH::=/x}"],
  ["fpath", ": ${fpath::=/x}"],
  ["BASH_LOADABLES_PATH", ": ${BASH_LOADABLES_PATH:=/x}"],
  ["PATH", ": ${PATH::=/x}"],
  ["path as an array", ": ${(A)path::=/x}"],
  ["NULLCMD", ": ${NULLCMD::=/x}"],
  ["READNULLCMD", ": ${READNULLCMD::=/x}"],
  ["EXECIGNORE", ": ${EXECIGNORE:=x}"],
  ["IFS", ": ${IFS::=x}"],
  ["IFS after a plain store", "IFS=; : ${IFS:=x}"],
  ["IFS with :=", ": ${IFS:=,}"],
  ["IFS with =", ": ${IFS=,}"],
  ["a dis_aliases element", ": ${dis_aliases[ls]::=x}"],
  ["a dis_galiases element", ": ${dis_galiases[ls]::=x}"],
  ["a dis_saliases element", ": ${dis_saliases[ls]::=x}"],
  ["LD_PRELOAD", ": ${LD_PRELOAD:=/x.so}"],
  ["DYLD_INSERT_LIBRARIES", ": ${DYLD_INSERT_LIBRARIES:=/x}"],
  ["a mapfile element", "zmodload zsh/mapfile; : ${mapfile[x.sh]::=y}"],
  ["a prefix assignment value", "x=${BASH_ENV:=/x} true"],
  ["a redirect target", ": > ${ZDOTDIR::=/x}"],
  ["a here-string", ": <<< ${fpath::=/x}"],
  ["a double-quoted word", ': "${PROMPT_COMMAND:=x}"'],
  ["an unquoted heredoc body", ": <<EOF\n${PATH::=/x}\nEOF"],
  ["a command substitution", ": $(: ${IFS::=x})"],
  ["a backtick substitution", ": `: ${NULLCMD::=/x}`"],
  ["a pad flag width writing PATH", ": ${(l:PATH=1:)x}"],
] as const;

/** Text the lexer reads as a quoted word; the command walk lexes it again where `eval` or `-c` runs it. */
const REFUSED_IN_RUN_TEXT = [
  ["eval text", "eval ': ${BASH_ENV:=/x}'"],
  ["bash -c text", "bash -c ': ${BASH_ENV:=/x}'"],
] as const;

const PASSED = [
  ["an unprotected default assigned", ": ${TMPDIR:=/tmp}"],
  ["an unprotected name", ": ${WGETRC:=x}"],
  ["a read with a default", "echo ${PATH:-/bin}"],
  ["a quoted read", 'echo "$PROMPT_COMMAND"'],
  ["names that only start or end like a hook", ": ${PATHX:=1} ${MYPATH:=1} ${fpathx::=1}"],
  ["a single-quoted expansion", "git commit -m '${BASH_ENV:=x}'"],
  ["a quoted heredoc body", ": <<'EOF'\n${PATH::=/x}\nEOF"],
  ["a plain IFS store", "IFS= read -r line"],
  ["a plain PATH store", "PATH=$PATH:/x make"],
  ["a plain HOME export", "export HOME=/tmp/h"],
  ["a quoted commit message", "git commit -m 'set ${X:=y} first'"],
] as const;

describe("an assigning expansion that writes a shell exec-hook parameter is refused by the lexer (TP-3293)", () => {
  it.each(REFUSED)("throws ParseError for %s", (_form, line) => {
    expect(() => tokenize(`${line}; ${PUSH}`)).toThrow(ParseError);
  });

  it.each(REFUSED)("denies %s through handle()", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("deny");
  });

  it.each(REFUSED_IN_RUN_TEXT)("denies %s through handle()", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("deny");
  });

  it.each(PASSED)("allows %s", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("pass");
  });

  it("puts every exec-hook name in PROTECTED", () => {
    expect(EXEC_HOOKS.filter((name) => !PROTECTED.has(name))).toEqual([]);
  });
});
