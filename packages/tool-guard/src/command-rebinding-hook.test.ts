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
    ["printf behind a run-time format that may be -v", `printf "$f" BASH_CMDS[y] /usr/bin/git; ${PUSH}`],
    ["print behind a run-time word that may be -v", `print "$f" commands[y] /usr/bin/git; ${PUSH}`],
    ["printf behind a run-time word ending in v", `printf "\${o}v" BASH_CMDS[y] /usr/bin/git; ${PUSH}`],
    ["printf with an unquoted first operand", `printf $args; ${PUSH}`],
    ["wait -p with a computed name", `wait -p "$n" $!; ${PUSH}`],
    ["a keyed list behind a leading -pA", `declare -pA BASH_CMDS=([y]=/usr/bin/git); ${PUSH}`],
    ["a keyed list behind a leading -p", `declare -p BASH_CMDS=([y]=/usr/bin/git); ${PUSH}`],
    ["a keyed list behind a leading -f", `declare -f BASH_CMDS=([y]=/usr/bin/git); ${PUSH}`],
    ["a zsh keyed list behind a leading -pA", `typeset -pA commands=([y]=/usr/bin/git); ${PUSH}`],
    ["a readonly keyed list behind a leading -pA", `readonly -pA BASH_CMDS=([y]=/usr/bin/git); ${PUSH}`],
    ["a keyed append behind a leading -p", `declare -p BASH_CMDS+=([y]=/usr/bin/git); ${PUSH}`],
    ["a local keyed list behind a leading -pA", `f() { local -pA BASH_CMDS=([y]=/usr/bin/git); ${PUSH}; }; f`],
    ["a keyed list with a glob key", `declare -A BASH_CMDS=([z?]=/usr/bin/git); 'z?' push origin HEAD:main`],
    ["an element with a glob key", `declare BASH_CMDS[g*]=/usr/bin/git; 'g*' push origin HEAD:main`],
    ["a keyed list with a brace key", `declare -A BASH_CMDS=([{}]=/usr/bin/git); '{}' push origin HEAD:main`],
    ["an element before a trailing -p", `declare BASH_CMDS[q]=/usr/bin/git -p; q push origin HEAD:main`],
    ["a keyed list before a trailing -p", `declare -A BASH_CMDS=([w]=/usr/bin/git) -p; w push origin HEAD:main`],
    ["an element before a trailing -f", `declare BASH_CMDS[k]=/usr/bin/git -f; k push origin HEAD:main`],
    ["a local element before a trailing -p", `f() { local BASH_CMDS[q]=/usr/bin/git -p; q push origin HEAD:main; }; f`],
    ["an element before a trailing -p under bash -c", `bash -c 'declare BASH_CMDS[q]=/usr/bin/git -p; q push origin HEAD:main'`],
    ["an element with a brace-expanding value", `declare BASH_CMDS[y]=/usr/bin/{,git}; ${PUSH}`],
    ["printf -v from an array", `a=(-v BASH_CMDS[y] /usr/bin/git); printf "\${a[@]}"; ${PUSH}`],
    ["printf -v from the positional parameters", `set -- -v BASH_CMDS[y] /usr/bin/git; printf "$@"; ${PUSH}`],
    ["zsh print -v from an array", `a=(-v commands[y] /usr/bin/git); print "\${a[@]}"; ${PUSH}`],
    ["printf from a zsh split", `x='-v BASH_CMDS[y] /usr/bin/git'; printf $=x; ${PUSH}`],
    ["a for loop over BASH_CMDS", "for BASH_CMDS in /usr/bin/git; do 0 push origin HEAD:main; done"],
    ["a select loop over BASH_CMDS", "select BASH_CMDS in /usr/bin/git; do 0 push origin HEAD:main; done"],
    ["a zsh for loop over commands", "for commands in /usr/bin/git; do 0 push origin HEAD:main; done"],
    ["a store through zstyle -e", `zstyle -e :z k 'commands[y]=/usr/bin/git'; ${PUSH}`],
    ["zsh print -v from an unquoted list", `a=(-v 'commands[y]' /usr/bin/git); print $a; y push origin HEAD:main`],
    ["zsh set -A from an unquoted list", `a=(-A commands y /usr/bin/git); set $a; y push origin HEAD:main`],
    ["bash compgen -V from a split word", `x='-V BASH_CMDS'; compgen $x -W y; ${PUSH}`],
    ["a quoted word that carries -A and its name", `x=-Acommands; set "$x" y /usr/bin/git; y push origin HEAD:main`],
    ["wait on a stored pid, which may split into -p NAME", "sleep 1 & pid=$!; wait $pid"],
    ["print of a word that may split into -v NAME", "print $x"],
    ["print of an unquoted parameter read", "print -l $commands[git]"],
    ["printf with a quoted run-time format that may be -vNAME", 'printf "$fmt" a'],
    ["read of a run-time name after --", `read -- "$n"; ${PUSH}`],
    ["zsh read -n, a flag, then a run-time name", `read -n "$n"; ${PUSH}`],
    ["zsh read -t, a flag, then a run-time name", `read -t "$n"; ${PUSH}`],
    ["read -p, a zsh flag, then a run-time name", `read -r -p "$n" line; ${PUSH}`],
    ["declare of a run-time name", `declare "$x"; ${PUSH}`],
    ["typeset of a run-time name", `typeset "$x"; ${PUSH}`],
    ["export of a run-time name", `export "$x"; ${PUSH}`],
    ["typeset of a run-time name and a value", `typeset "$n"=/usr/bin/git; ${PUSH}`],
    ["declare -A of a run-time name", `declare -A "$n"; ${PUSH}`],
    ["read of a run-time name", `read "$n"; ${PUSH}`],
    ["getln of a run-time name after --", `getln -- "$n"; ${PUSH}`],
    ["sysread of a run-time name after --", `sysread -- "$n"; ${PUSH}`],
    ["mapfile of a run-time name after --", `mapfile -- "$n"; ${PUSH}`],
    ["zstyle -s into a run-time name", `zstyle -s :a k "$n"; ${PUSH}`],
    ["an export of a run-time word", `export $(cmd); ${PUSH}`],
    ["an export of a braced run-time name with a value", `export \${n}=x; ${PUSH}`],
    ["an export of a name built by command substitution with a subscript", `export BASH$(echo _CMDS)[y]=/x; ${PUSH}`],
    ["a declare with a quoted run-time option word then an assignment", `declare "$F" r=BASH_CMDS; ${PUSH}`],
    ["a declare -n through a name held in a variable", `F=commands; declare -n r=$F; ${PUSH}`],
    ["a dynamic declarer word refuses the line even when no rebound name runs", "export $(cmd); git status"],
    ["zpty -r into a run-time name", `zpty -r z "$n"; ${PUSH}`],
    ["zpty -r into a run-time name after --", `zpty -r -- z "$n"; ${PUSH}`],
    ["zpty -r into an unquoted run-time name", `zpty -r z $n; ${PUSH}`],
    ["zgetattr into a run-time name", `zgetattr f a "$n"; ${PUSH}`],
    ["zgetattr into a run-time name after --", `zgetattr -- f a "$n"; ${PUSH}`],
    ["zgetattr -h into a run-time name", `zgetattr -h f a "$n"; ${PUSH}`],
    ["zlistattr into a run-time name", `zlistattr f "$n"; ${PUSH}`],
    ["zlistattr into a run-time name after --", `zlistattr -- f "$n"; ${PUSH}`],
    ["zcurses input into a run-time name", `zcurses input w "$n"; ${PUSH}`],
    ["zcurses input into a run-time name after --", `zcurses -- input w "$n"; ${PUSH}`],
    ["zcurses position into a run-time name", `zcurses position w "$n"; ${PUSH}`],
    ["integer of a run-time name", `integer "$x"; ${PUSH}`],
    ["float of a run-time name", `float "$x"; ${PUSH}`],
    ["zsh stat -H into a run-time name", `zmodload zsh/stat; stat -H "$n" /usr/bin/git; name push origin HEAD:main`],
    ["zsh stat -H into commands", "zmodload zsh/stat; stat -H commands /usr/bin/git; name push origin HEAD:main"],
    ["zsystem flock -f into a run-time name", `zsystem flock -f "$n" f; ${PUSH}`],
    ["ztie into a run-time name", `ztie -d db/gdbm -f f "$n"; ${PUSH}`],
    ...["", "zmodload zsh/stat; "].flatMap((load) => [
      [`${load}stat behind a run-time option word`, `${load}stat $o commands s; link push origin HEAD:main`],
      [`${load}stat behind a quoted run-time option word`, `${load}stat "$o" commands s; link push origin HEAD:main`],
      [`${load}stat -L behind a run-time option word`, `${load}stat -L $o commands s; link push origin HEAD:main`],
      [`${load}builtin stat behind a run-time option word`, `${load}builtin stat $o commands s; link push origin HEAD:main`],
      [`${load}stat with a clustered -LH`, `${load}stat -LH commands s; link push origin HEAD:main`],
      [`${load}stat with a run-time word in a -L cluster`, `${load}stat "-L$o" commands s; link push origin HEAD:main`],
      [`${load}stat behind --, which zsh skips once`, `${load}stat -- "$o" commands s; link push origin HEAD:main`],
      [`${load}stat -H commands behind --`, `${load}stat -- -LH commands s; link push origin HEAD:main`],
      [`${load}zstat -H commands behind --`, `${load}zstat -- -LH commands s; link push origin HEAD:main`],
    ]),
    ["compadd behind a run-time option word", `compadd $o commands x; ${PUSH}`],
    ["let with a literal store into commands", `let 'commands[y]=0'; ${PUSH}`],
    ["let with a literal store into BASH_CMDS", `let 'BASH_CMDS[y]=0'; ${PUSH}`],
    ["let of a run-time word", `e='commands[y]=0'; let "$e"; ${PUSH}`],
    ["let of an unknown run-time word", `let "$e"; ${PUSH}`],
    ["(( )) of an unknown run-time word", `(( $e )); ${PUSH}`],
    ["(( )) mixing a run-time word into a sum", `(( i + $e )); ${PUSH}`],
    ["shift by an unknown run-time word", `shift "$e"; ${PUSH}`],
    ["shift by arithmetic of a run-time word", `shift $(( $e )); ${PUSH}`],
    ["a zsh subscript read from a run-time word", `e='commands[y]=0'; echo \${a[$e]}; ${PUSH}`],
    ["a zsh subscript read from an unknown run-time word", `echo \${a[$e]}; ${PUSH}`],
    ["a bash fd-variable redirect into BASH_CMDS", `{BASH_CMDS[y]}>f; ${PUSH}`],
    ["a bash fd-variable redirect into BASH_CMDS on exec", `exec {BASH_CMDS[y]}>f; ${PUSH}`],
    ["an fd-variable redirect into commands", `exec {commands[y]}>f; ${PUSH}`],
    ["an fd-variable redirect into an element a run-time word indexes", `exec {a[$e]}>f; ${PUSH}`],
    ["an element assignment a run-time word indexes", `a[$e]=1; ${PUSH}`],
    ["a substitution inside $(( ))", `echo $(( $(git status) )); ${PUSH}`],
    ["a run-time word in a legacy $[ ]", `echo $[ $e ]; ${PUSH}`],
    ["return of a run-time word", `f() { return "$e"; }; f; ${PUSH}`],
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
    ["shift by arithmetic", "shift $((OPTIND-1))"],
    ["printf of an unquoted word after --", "printf -- $x"],
    ["print of a word after --", "print -- $x"],
    ["wait on a stored pid after --", "sleep 1 & pid=$!; wait -- $pid"],
    ["printf of an array after a literal format", `printf '%s\\n' "\${a[@]}"`],
    ["a for loop over an ordinary name", "for f in a b; do echo $f; done"],
    ["declare -p of a rebinding parameter", "declare -p BASH_CMDS"],
    ["typeset -p of a rebinding parameter", "typeset -p commands"],
    ["declare -p of an assignment, which assigns nothing", "declare -p X=5; git status"],
    ["declare -f of an assignment, which assigns nothing", "declare -f X=5; git status"],
    ["a getopts script shift", "while getopts ab o; do :; done; shift $((OPTIND-1))"],
    ["a sourced getopts script", "source ./opts.sh"],
    ["a sourced script that waits on a pid", "source ./bg.sh"],
    ["a run script that waits on a pid", "bash ./bg.sh"],
    ["a declare option the shell rejects", "declare -Q Y=status; git status"],
    ["a gh word that expands to an option", 'gh pr edit 12 "--$X"'],
    ["a gh option word that varies", "gh --$F x pr merge"],
    ["stat of a run-time file after a doubled --", 'stat -- -- "$f"'],
    ["stat of a run-time file behind ./", 'stat ./"$f"'],
    ["an export of PATH with a run-time value", 'export PATH="$HOME/bin"'],
    ["a literal increment in (( ))", "(( i++ )) && git status"],
    ["let with literal arithmetic", "let n=n+1; git status"],
    ["(( )) over argument and status counts", "(( $# > 0 && $? == 0 )) && git status"],
    ["an fd-variable redirect into an ordinary name", "exec {fd}>log; git status"],
    ["an fd-variable redirect on a bare redirect", "{fd}>log; git status"],
    ["a subscript with a literal index", "echo ${a[1]}; git status"],
    ["the length of an element", "echo ${#a[0]} ${#a[@]}; git status"],
    ["a quoted word that only looks like a subscript", "gh api x -f 'a[$K]=b'"],
    ["shift by arithmetic over literals", "shift $((OPTIND-1)); git status"],
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
