import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXEC_HOOKS, PROTECTED } from "./protected-params.js";

type Tag = "exec-hook" | "modelled" | "inert";

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const tagAll = (tag: Tag, names: string): [string, Tag][] => words(names).map((name) => [name, tag]);

/**
 * Every zsh 5.9 special parameter (`${(k)parameters[(R)*special*]}` with every module in `$module_path` loaded, zsh/example
 * excluded) and the positional and status names. `exec-hook`: a store runs code, or rebinds a command, a path or a startup
 * file. `modelled`: the guard reads the name's value somewhere else. `inert`: a store changes nothing the guard classifies.
 */
const ZSH_SPECIAL = new Map<string, Tag>([
  ...tagAll("exec-hook", "aliases commands dis_aliases dis_functions dis_galiases dis_saliases fpath FPATH functions galiases HOME IFS mapfile module_path MODULE_PATH nameddirs NULLCMD options path PATH PROMPT prompt PROMPT2 PROMPT3 PROMPT4 PS1 PS2 PS3 PS4 READNULLCMD saliases SPROMPT"),
  ...tagAll("modelled", "LINENO OPTIND OPTARG"),
  ...tagAll(
    "inert",
    "_ - ! ? @ * # $ 0 ARGC argv builtins cdpath CDPATH COLUMNS dirstack dis_builtins dis_functions_source dis_patchars dis_reswords EGID EPOCHREALTIME EPOCHSECONDS epochtime errnos EUID fignore FIGNORE funcfiletrace FUNCNEST funcsourcetrace funcstack functions_source functrace GID histchars HISTCHARS HISTCMD history historywords HISTSIZE jobdirs jobstates jobtexts KEYBOARD_HACK keymaps LANG langinfo LINES mailpath MAILPATH manpath MANPATH modules parameters patchars pipestatus PPID psvar PSVAR RANDOM reswords SAVEHIST SECONDS SHLVL status sysparams TERM termcap terminfo TRY_BLOCK_ERROR TRY_BLOCK_INTERRUPT TTYIDLE UID userdirs usergroups USERNAME watch WATCH widgets WORDCHARS zcurses_attrs ZCURSES_COLOR_PAIRS zcurses_colors ZCURSES_COLORS zcurses_keycodes zcurses_windows zsh_eval_context ZSH_EVAL_CONTEXT zsh_scheduled_events ZSH_SUBSHELL",
  ),
]);

/** Every bash 5.3 variable `env -i bash --norc -c 'compgen -v'` lists. */
const BASH_VARIABLES = new Map<string, Tag>([
  ...tagAll("exec-hook", "BASH_ALIASES BASH_CMDS BASH_LOADABLES_PATH BASHOPTS IFS PATH PS4 SHELLOPTS"),
  ...tagAll("modelled", "LINENO OPTIND"),
  ...tagAll(
    "inert",
    "BASH BASHPID BASH_ARGC BASH_ARGV BASH_ARGV0 BASH_COMMAND BASH_EXECUTION_STRING BASH_LINENO BASH_MONOSECONDS BASH_SOURCE BASH_SUBSHELL BASH_VERSINFO BASH_VERSION COMP_WORDBREAKS DIRSTACK EPOCHREALTIME EPOCHSECONDS EUID GROUPS HISTCMD HOSTNAME HOSTTYPE MACHTYPE OPTERR OSTYPE PPID PWD RANDOM SECONDS SHELL SHLVL SRANDOM TERM UID _",
  ),
]);

/** Names a manual, not the shell's own variable listing, documents as running code: the prompts bash prints, the startup file, the loader. */
const MANUAL_ONLY = words("PS0 PS1 PS2 PS3 PROMPT_COMMAND RPS1 RPS2 RPROMPT RPROMPT2 BASH_ENV ENV ZDOTDIR EXECIGNORE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH precmd_functions preexec_functions chpwd_functions periodic_functions zshaddhistory_functions zshexit_functions zsh_directory_name_functions");

const execHooks = (table: Map<string, Tag>): string[] => [...table].filter(([, tag]) => tag === "exec-hook").map(([name]) => name);

describe("the exec-hook universe (TP-3293)", () => {
  it.each([
    ["zsh", ZSH_SPECIAL],
    ["bash", BASH_VARIABLES],
  ])("puts every %s exec-hook name in PROTECTED", (_shell, table) => {
    expect(execHooks(table).filter((name) => !PROTECTED.has(name))).toEqual([]);
  });

  it("puts every manual-only exec-hook name in PROTECTED", () => {
    expect(MANUAL_ONLY.filter((name) => !PROTECTED.has(name))).toEqual([]);
  });

  it("keeps every EXEC_HOOKS name tagged as a hook where a shell lists it", () => {
    const listed = EXEC_HOOKS.filter((name) => ZSH_SPECIAL.has(name) || BASH_VARIABLES.has(name));
    const untagged = listed.filter((name) => ![ZSH_SPECIAL, BASH_VARIABLES].some((table) => table.get(name) === "exec-hook"));
    expect(untagged).toEqual([]);
  });
});

const run = (shell: string, args: string[], cwd?: string): { status: number | null; stdout: string } => {
  const result = spawnSync(shell, args, { cwd, encoding: "utf8", input: "", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return { status: result.status, stdout: result.stdout };
};

const zsh = run("zsh", ["-f", "-c", "true"]).status === 0;
const bash = run("bash", ["--norc", "-c", "true"]).status === 0;

/** Lists every special parameter the live zsh has once every module it ships is loaded. */
const ZSH_LIST_SCRIPT = [
  "for m in $(cd $module_path && print -l **/*.so(N) | sed 's/\\.so$//'); do",
  "  [[ $m == zsh/example ]] && continue",
  "  zmodload $m 2>/dev/null",
  "done",
  "print -rl -- ${(k)parameters[(R)*special*]}",
].join("\n");

describe.skipIf(!zsh)("every special parameter of the live zsh is tagged (TP-3293)", () => {
  it("has a tag for each name", () => {
    const live = words(run("zsh", ["-f", "-c", ZSH_LIST_SCRIPT]).stdout).filter((name) => !ZSH_SPECIAL.has(name));
    expect(live).toEqual([]);
  });
});

describe.skipIf(!bash)("every variable of the live bash is tagged (TP-3293)", () => {
  it("has a tag for each name", () => {
    const live = words(run("bash", ["--norc", "-c", "compgen -v"]).stdout).filter((name) => !BASH_VARIABLES.has(name));
    expect(live).toEqual([]);
  });
});

/** Runs `script` in a scratch directory and says whether it created the `marker` file. */
function marks(shell: string, args: string[], script: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-hook-"));
  try {
    run(shell, [...args, script], dir);
    return fs.existsSync(path.join(dir, "marker"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!zsh)("zsh really runs a marker through the refused forms (TP-3293)", () => {
  it.each([
    ["chpwd_functions", "d=$PWD; f(){ : > $d/marker; }; : ${(A)chpwd_functions::=f}; cd /"],
    ["fpath with autoload", "mkdir fd; print ': > marker' > fd/f; : ${fpath::=fd}; autoload -U f; f"],
    ["dis_aliases with enable -a", "builtin : ${dis_aliases[ls]::=': > marker'}; enable -a ls; eval ls"],
    ["NULLCMD", "printf '#!/bin/sh\\n: > marker\\n' > x; chmod +x x; : ${NULLCMD::=./x}; > f"],
  ])("%s", (_name, script) => {
    expect(marks("zsh", ["-f", "-c"], script)).toBe(true);
  });
});

describe.skipIf(!bash)("bash really runs a marker through the refused forms (TP-3293)", () => {
  it.each([
    ["BASH_ENV with bash -c", "printf ': > marker\\n' > rc; : ${BASH_ENV:=rc}; export BASH_ENV; bash --norc --noprofile -c true"],
    ["PROMPT_COMMAND with bash -i", ": ${PROMPT_COMMAND:=': > marker'}; export PROMPT_COMMAND; bash --norc --noprofile -i </dev/null"],
  ])("%s", (_name, script) => {
    expect(marks("bash", ["--norc", "--noprofile", "-c"], script)).toBe(true);
  });
});
