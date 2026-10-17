# tool-guard

**Tier 0 · primitives.** Depends on [authority](./authority.md), also tier 0.

```sh
npm install @titan-design/tool-guard
```

Status: public on npm. The owner publishes the first version and installs the hook by
hand.

## The problem it solves

The authority table says who may merge, release, read a credential, edit permission config or
send data off the machine, but nothing stopped a Claude Code agent from doing those things
through an ordinary tool call. A Bash command can spell one action dozens of ways: through
`bash -c`, a heredoc, a variable, a symlink, `xargs`, a package runner or a script on disk.

The package adds three layers. `@titan-design/tool-guard/shell` lists every simple command a
Bash string would run, without running it. `classify` maps one PreToolUse event to the guarded
actions it would take, as data, with no actor attached. `decide` evaluates those actions
against authority's table for every agent class the hook cannot rule out and keeps the
strictest verdict. The `titan-tool-guard` bin wires the three into a PreToolUse hook that denies
with a one-line, actionable reason.

## When to reach for it

A hook or guard that must see what a tool call would actually do. Use the bin as the
PreToolUse hook; use `classify` when you need the actions without a decision, and `/shell`
when you need only the command list. `checkPreferences` checks house rules that are not
authority actions. To decide anything that is not a tool call (who may resolve a gate,
whether a pull request may merge), call [authority](./authority.md) directly.

## Example

Verified against 0.1.0 (unreleased).

```ts
import { classify, decide, nodeContext, observeActor, parseHookEvent } from "@titan-design/tool-guard";

const event = parseHookEvent({
  tool_name: "Bash",
  cwd: "/home/you/projects/app",
  tool_input: { command: "base64 < ~/.npmrc" },
});
if (event.kind !== "malformed" && event.kind !== "other") {
  const actions = classify(event, nodeContext("/home/you"));
  // [{ action: "secret-read", spelling: "bash.secret.redirect-in", subject: { pattern: "home:.npmrc" }, remedy: "..." }]
  const decision = decide(actions, observeActor({}, null));
  // { outcome: "deny", ruleId: "SEC-CO", action: "secret-read", spelling: "bash.secret.redirect-in", reason: "authority-guard denied ..." }
}
```

## Command line

```sh
titan-tool-guard hook            # answer one PreToolUse event on stdin; always exits 0
titan-tool-guard print-settings  # print the settings entry as JSON; writes nothing
titan-tool-guard report          # deny counts per UTC day and rule, from the log
```

`hook` reads stdin for at most 2 s. On a deny it prints
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`
and appends one log line; otherwise it prints nothing. It never answers `ask` or `allow`.

| Input | Answer |
|---|---|
| a call that classifies as a guarded action | deny, one `deny` log line |
| a call that classifies as nothing | silent, no log line |
| stdin that is not JSON, or a known tool with the wrong input shape | silent, one `error shape` line |
| a Bash command that cannot be parsed | deny if its text, as typed or with quotes and backslashes removed and whitespace collapsed, names a guarded path, credential file name, `gh pr merge`, `/merge`, `publish`, `deploy` or `gist`; otherwise silent with an `error parse` line. A name spelled through a variable or glob is not seen |
| a Bash command over 8 KiB | not classified; always denies, asking for shorter commands or a script file |
| any call still unchecked 3.5 s after node starts (`HOOK_DEADLINE_MS`) | deny, asking to split the command into smaller Bash calls; one `deny` line with action `timeout`. An answer that arrives later is dropped |
| any call whose worker thread throws, exits or answers with the wrong shape | deny, one `deny` line with action `crash` |
| an authority table that cannot load | deny every classified call; unclassified calls are silent |

The log is `$TITAN_TOOL_GUARD_LOG`, else
`${XDG_STATE_HOME:-$HOME/.local/state}/titan-tool-guard/guard.log`: tab-separated `ts`, `kind`,
`rule`, `action`, `spelling`, `actor`, `actor_id`, `session`, `tool`, `tool_use`, `subject`.
It never holds command text, file contents, URLs, the cwd or any environment value except the
agent id. A log path that names a guarded path or lands in a `~/.claude*` tree, as typed or
through a symlinked parent, is refused just before the append.

## What it deliberately does not do

- It is not a security boundary. The hook runs as the same OS user as the agent; anything the
  agent runs outside a tool call is never seen, and every guarded file stays readable by that
  user.
- It never installs itself. `print-settings` prints JSON for the owner to paste. The hook's
  only write is its log append, and the log path check above keeps that out of settings files.
- It does not follow commands built at run time (`$(...)`, `eval "$x"`), and reads a script run
  by path one level deep.
- An HTTP client that sends a write method to a URL whose host, or whose `api.github.com` path, is known only at run time reads as a merge.
- A curl, wget or httpie config file is checked only within one command line: an rc file planted by an earlier Bash call (`echo method=PUT > ~/.wgetrc`, then `wget <merge URL>` in the next call) is not seen (TP-2861 tracks the path-layer guard). A download that names its file from the URL (`curl -O`/`-J`, a bare `wget "$U"`) is not read as an rc write either. An archive extract (tar, bsdtar or cpio extract, unzip, pax -r, 7z x/e, ar x, jar x) counts as an rc write in any directory, because its member paths may be absolute. Other unpackers and interpreters are not read.
- A line that rebinds a command name is refused whole, with its own reason: zsh `hash y=/usr/bin/git`, bash `hash -p`, and a store into `commands`, `BASH_CMDS`, `functions`, `dis_functions` or `nameddirs` (`commands[y]=…`, `commands+=(…)`, `set -A commands …`, `zstyle -e … 'commands[y]=…'`), because the guard classifies by command name and would read `y push` as an unknown program (TP-2706). Listing, looking up or resetting the hash table (`hash`, `hash git`, `hash -r`) passes. Not seen: a declarer whose variable is only known at run time (`export $(cmd)`, `declare "$F"`), which the guard allows as it did before; a command word only known at run time that is `hash` then (`"$(printf ha%s sh)" y=/x`), fully dynamic `eval` text, `autoload` from an `fpath` file and `zmodload` tricks, and a rebinding written into `~/.zshrc` for a later session.
- A builtin with a store option (`print`, `printf`, `set`, `read`, `compgen`, `mapfile`, `wait`, `zparseopts`, `strftime`, `zstat` and the rest of `STORE_OPTION_BUILTINS`) that meets a run-time word where it still reads options (`print $x`, `set "$x"`, `print *`) is refused the same way, quoted or not, because that word may be `-v commands[y]`. Write `--` before the run-time words to pass: `print -- $x`, `wait -- $pid`, `read -- "$V"` (TP-3320).
- It does not classify `titan-factory` verbs.

## Known gaps

- Stdin named through the working directory or a symlink (`cd /dev && bash stdin`) is not
  read as stdin. TP-3240 tracks it.

## Gotchas

- A shell that runs stdin, or a descriptor its script operand names, is refused when the line
  does not show that text: `bash < $F`, `bash /dev/stdin <&3`, `bash /dev/fd/3` with no `3<`,
  or `bash {fd}< ./x.sh /dev/fd/10`, whose descriptor number from 10 up the shell picks.
- A `{name}` before a redirect is read as each shell reads it and refused if any reading is:
  zsh reads `{fd}<` and `{fd} <` as the descriptor, dash keeps both as words, and bash reads
  only a glued `{fd}<` or `{a[0]}<` as one (`env -C {x} </dev/null git push` runs the push in
  bash, and `env -C {x} </dev/null {fd}< ./x.sh bash /dev/fd/10` runs x.sh in bash alone).
  When the readings leave a different directory or variable (`cd {x} </dev/null`), the rest
  of the command list is checked once per reading; a line that would need more than 8 such
  walks is refused.
  A shell that a `-c` string, `eval`, `emulate -c` or `find -exec` starts inherits its runner's
  stdin and descriptors, so `bash -c bash < $F` is refused too.
  Run the script by a literal path, or redirect a literal file (`bash /dev/stdin < ./x.sh`).
- A gate verdict denies. The hook cannot check a resolved gate yet, so `MRG-CO` and `REL-CO`
  deny with a reason naming the gate.
- The mention rule is broad: `echo ~/.npmrc`, or a pull request body that names `~/.npmrc`,
  denies as a credential read.
- There is no owner bypass. Every call inside Claude Code is evaluated as an agent, and
  `TITAN_TOOL_GUARD_BYPASS` is ignored: the hook runs as the agent's OS user, so nothing it
  can check is beyond the agent's reach. Take a guarded action from a terminal outside Claude
  Code.
- zsh's precommand modifiers `noglob`, `nocorrect` and `-` are read as wrappers, like
  `command` and `exec`, so `noglob git push origin HEAD:main` denies. The reading is generous:
  `command noglob git push` denies although zsh would fail to run it.
- Claude Code treats a hook that times out or exits non-zero as a non-blocking error and runs
  the call, so the bin exits 0 on every path. The check runs in a worker thread, so the main
  thread's deadline timer fires during a long synchronous classification; the bin then stops
  the worker. The 3.5 s deadline leaves 1.5 s of the 5 s `timeout` in the printed settings entry
  for node start-up, the deny and the log append. The worker adds about 50 ms to every call.
  A crash of the bin's main thread still lets the call run.

## Where it came from

The tokenizer is a TypeScript port of the owner's git-safety PreToolUse hook, plus redirect
targets, heredoc bodies, decoded `$'...'` strings and literal variable tracking. The families,
decision and hook are new, built in TP-403's slices (TP-488, TP-489, TP-490, TP-491).
