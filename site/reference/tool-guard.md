# tool-guard

**Tier 0 · primitives.** Depends on [authority](./authority.md), also tier 0.

```sh
npm install @titan-design/tool-guard
```

Status: private and unpublished while TP-403 lands. The owner publishes the first version and
installs the hook by hand.

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
| a Bash command that cannot be parsed | deny if its raw text names a guarded path, credential file name, `gh pr merge`, `/merge`, `publish`, `deploy` or `gist`; otherwise silent with an `error parse` line |
| an authority table that cannot load | deny every classified call; unclassified calls are silent |
| `TITAN_TOOL_GUARD_BYPASS=1` in the hook's launch environment | evaluated as `owner-terminal`; a guarded call is logged as `bypass` |

The log is `$TITAN_TOOL_GUARD_LOG`, else
`${XDG_STATE_HOME:-$HOME/.local/state}/titan-tool-guard/guard.log`: tab-separated `ts`, `kind`,
`rule`, `action`, `spelling`, `actor`, `actor_id`, `session`, `tool`, `tool_use`, `subject`.
It never holds command text, file contents, URLs, the cwd or any environment value except the
agent id.

## What it deliberately does not do

- It is not a security boundary. The hook runs as the same OS user as the agent; anything the
  agent runs outside a tool call is never seen, and every guarded file stays readable by that
  user.
- It never installs itself. No code path writes a settings file, hooks directory, profile or rc
  file; `print-settings` prints JSON for the owner to paste.
- It does not follow commands built at run time (`$(...)`, `eval "$x"`), and reads a script run
  by path one level deep.
- It does not classify `titan-factory` verbs.

## Gotchas

- A gate verdict denies. The hook cannot check a resolved gate yet, so `MRG-CO` and `REL-CO`
  deny with a reason naming the gate.
- The mention rule is broad: `echo ~/.npmrc`, or a pull request body that names `~/.npmrc`,
  denies as a credential read.
- Only the hook's launch environment counts for the bypass. `TITAN_TOOL_GUARD_BYPASS=1 cmd`
  typed by the model sets it for `cmd` alone and still denies.
- Claude Code treats a hook that times out or exits non-zero as a non-blocking error and runs
  the call, so the bin exits 0 on every path.

## Where it came from

The tokenizer is a TypeScript port of the owner's git-safety PreToolUse hook, plus redirect
targets, heredoc bodies, decoded `$'...'` strings and literal variable tracking. The families,
decision and hook are new, built in TP-403's slices (TP-488, TP-489, TP-490, TP-491).
