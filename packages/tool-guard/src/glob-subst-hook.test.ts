import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { GlobSubstError } from "./shell/glob-subst-refusal.js";
import { extractCommands } from "./shell/commands.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const noFiles: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

const port: HookPort = { context: nodeContext(HOME, noFiles), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function stdoutFor(command: string): Promise<string> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: { command } });
  return (await handle(input, {}, port)).stdout;
}

const hasZsh = spawnSync("zsh", ["-fc", "true"]).status === 0;

describe("handle: a line that may turn on zsh GLOB_SUBST", () => {
  it.each([
    "setopt globsubst",
    "setopt GLOB_SUBST",
    "setopt noglobsubst",
    "unsetopt noglobsubst",
    "setopt -o globsubst",
    "set -o globsubst",
    "emulate sh",
    "emulate -L ksh",
    "emulate zsh -o globsubst",
    "zsh -o globsubst -c x",
    "zsh --emulate sh -c x",
    "setopt -- globsubst",
    "setopt -m 'glob*'",
    "setopt $o",
    'setopt "$o"',
    "s{etopt,} globsubst",
    "setopt ~root",
    "ARGV0=sh zsh -c x",
    "exec -a sh zsh -c x",
    "env --argv0 sh zsh -c x",
    "builtin setopt globsubst",
    "command setopt globsubst",
    "noglob setopt globsubst",
    "eval 'setopt globsubst'",
    "sh -c 'zsh -o globsubst -c x'",
    "bash -c 'setopt globsubst'",
    "echo $(setopt globsubst)",
    "f() { setopt globsubst; }; f",
    "echo globsubst | xargs setopt",
    "echo setopt globsubst | xargs sh -c",
    "emulate zsh -c 'setopt globsubst'",
    "emulate sh -c x",
    "options[globsubst]=on",
    "options+=(globsubst on)",
    "typeset -A options",
    "x=on; options[globsubst]=$x",
    "read -A options",
    "typeset $n=on",
    "n=options; typeset -n r=$n; r[globsubst]=on",
    "typeset -n r=options; r[globsubst]=on",
    "printf -v options[globsubst] %s on",
    "zstyle -a ':x' y options",
    "zsh-static -o globsubst -c x",
    "setopt glob{,}subst",
    '"$c" -S \'zsh -o globsubst -c x\'',
    "timeout $O 5 zsh -o globsubst -c x",
    "export ARGV0=sh; zsh -c x",
    "ARGV0=sh; zsh -c x",
    "typeset ARGV0=sh",
  ])("denies %s", async (command) => {
    const out = await stdoutFor(command);
    expect(out).toContain("GLOB_SUBST");
    expect(out).toContain("deny");
  });

  it.each([
    "setopt (glob|x)subst",
    "$c --emulate=ksh -c x",
    "$c $o",
    "sudo $a timeout $O 5 setopt globsubst",
    ": ${options[globsubst]::=on}",
    ": ${(P)n::=on}",
    "y='${options[globsubst]::=on}'; : ${(e)y}",
  ])("denies %s whatever the reason", async (command) => {
    expect(await stdoutFor(command)).toContain('"permissionDecision":"deny"');
  });

  it("refuses a command an alias expands to setopt globsubst", () => {
    expect(() => extractCommands("s", { refuseGlobSubst: true, aliases: new Map([["s", ["setopt globsubst"]]]) })).toThrow(GlobSubstError);
  });

  it.each([
    "setopt nonomatch",
    "setopt extendedglob",
    "emulate -L zsh",
    "emulate zsh -c 'echo hi'",
    "set -o pipefail",
    "set -e",
    "set -- a b",
    "zsh -o pipefail -c x",
    "bash -o globsubst -c x",
    '[ -n "$x" ]',
    "[[ -f $f ]]",
    "grep -r options .",
    "ls options",
    "cat options",
    'pytest "$f"',
    './x.sh "$a"',
    "git commit -m 'setopt globsubst'",
    "echo options",
    "x=1; echo $x",
    "$SUDO ./install.sh",
    "echo '${(P)n::=x}'",
    "bash -c 'declare I\\FS=,'",
    "x=1",
    "read line",
  ])("allows %s", async (command) => {
    expect(await stdoutFor(command)).toBe("");
  });

  it.skipIf(!hasZsh)("zsh itself runs a glob qualifier under the denied spellings and not the allowed ones", () => {
    const probe = (setup: string) =>
      spawnSync("zsh", ["-fc", `${setup}; y='*(e:echo ran:)'; : $y`], { encoding: "utf8" });
    expect(probe("setopt globsubst; setopt extendedglob").stderr).not.toContain("no matches");
    expect(probe("setopt nonomatch").stdout).toBe("");
  });
});
