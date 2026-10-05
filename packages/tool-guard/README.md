# @titan-design/tool-guard

Classifies Claude Code tool calls into guarded authority actions, with a POSIX shell tokenizer

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI. Its one titan
dependency is `@titan-design/authority`, also tier 0, which owns the decision table.

Status: private and unpublished while TP-403 lands in slices. `classify` covers all five
families, secret, config, merge, release and egress, so it turns an event into the guarded
actions it would take (a merge, a release, a credential read, a permission-config edit, data
sent off the host allowlist). `decide`, the PreToolUse hook and the
`titan-tool-guard` bin turn a classified action into a deny. The owner installs the hook by
hand; see [Install](#install-owner-only).

## What it guards, and what it cannot

The hook answers every `Bash`, `Read`, `Grep`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit`
call before it runs. When the call would merge, release, read a credential, edit permission
config or send data off the allowlist, it prints a PreToolUse deny with a one-line reason that
says what to do instead. Otherwise it prints nothing. It never answers `ask` or `allow`, so it
cannot override the session's permission mode or another hook.

**Same-user limit.** The hook runs as the same OS user as the agent it guards. It is a
guard against accidents and against the spellings it knows, not a security boundary: anything
the agent runs outside a tool call (a background process it started, a script that a later
build step runs, a program that reads a file under a computed name) is never seen. Every
guarded file stays readable by that user. The OS account is the real boundary.

**Residual risk.**

- Commands built at run time (`$(...)`, `read`, `printf -v`, `eval "$x"`) are not followed.
  A script run by path is read one level deep.
- A Bash command the tokenizer cannot parse passes, unless its text names a guarded
  path, a distinctive credential file name, or `gh pr merge`, `/merge`, `publish`, `deploy`,
  `gist` (owner decision D6). Then it denies and asks for simpler commands. The text is checked
  as typed and with quotes and backslashes removed and whitespace runs collapsed, so
  `gh pr mer''ge` counts. A name spelled through a variable or a glob (`F=mrc; cat ~/.np$F`,
  `cat ~/.np*rc`) in an unparseable command is not seen and passes: D6's residual.
- Claude Code treats a hook that times out (5 s) or crashes as a non-blocking error, so the
  call runs. The bin exits 0 on every path and gives stdin 2 s. A Bash command over 8 KiB
  (`MAX_COMMAND_BYTES`) is not classified, since padding could push classification past the
  timeout. It denies whatever it names, and the reason asks for shorter commands or a script file.
- The mention rule is broad: any argument naming a secret path counts as a read, so
  `echo ~/.npmrc` and a `gh pr create --body` that names `~/.npmrc` deny too.

## Command line

```sh
titan-tool-guard hook            # answer one PreToolUse event on stdin; always exits 0
titan-tool-guard print-settings  # print the settings entry as JSON; writes nothing
titan-tool-guard report          # deny counts per UTC day and rule, from the log
```

No code path is meant to write a settings file, a hooks directory, a profile or an rc file. The
only write is the hook's append of its log line, and the log path is checked first (see Log).

**Actor.** With no bypass, every call is evaluated for `coordinator`, `worker` and `headless`
together and the strictest verdict wins (owner decision D2). A gate verdict denies too, since
the hook cannot check a resolved gate yet, and the reason names the gate rule.

**Bypass.** `TITAN_TOOL_GUARD_BYPASS=1 claude` starts a session with owner authority: calls are
evaluated as `owner-terminal` and each guarded one is logged as `bypass` (owner decision D3).
Only the hook's own environment at launch counts; `TITAN_TOOL_GUARD_BYPASS=1 gh pr merge 3`
typed by the model still denies. Never export it from a shell rc file.

**Log.** `$TITAN_TOOL_GUARD_LOG`, else
`${XDG_STATE_HOME:-$HOME/.local/state}/titan-tool-guard/guard.log`, mode 0600 in a 0700
directory. Before each append the path is refused when, as typed or with its deepest existing
ancestor resolved through symlinks, it names a guarded path or lands in a `~/.claude*` tree; the
final file is opened with `O_NOFOLLOW`. The check runs just before the open, so a link swapped
in between the two is not caught. One tab-separated line per deny, bypass or error:

```
ts  kind  rule  action  spelling  actor  actor_id  session  tool  tool_use  subject
2026-01-02T03:04:05.000Z  deny  MRG-WK  merge  bash.merge.gh-pr-merge  coordinator+worker+headless  impl-7  sess-1  Bash  -  pr=3
2026-01-02T03:04:06.000Z  error  parse  Bash  sess-1
```

The subject holds only safe keys: a guarded pattern id (`home:.npmrc`, never the path typed),
`pr`, `branch`, `tool` or an egress `host`. Command text, file contents, URLs, the cwd and every
environment value except the agent id are never logged, because a denied command is exactly
the one likely to hold a token.

## Library

```ts
import { classify, decide, nodeContext, observeActor, parseHookEvent } from "@titan-design/tool-guard";

const event = parseHookEvent(JSON.parse(stdin));
if (event.kind !== "malformed" && event.kind !== "other") {
  const actions = classify(event, nodeContext("/home/you"));
  const decision = decide(actions, observeActor(process.env, event.sessionId));
  // { outcome: "deny", ruleId: "SEC-CO", action: "secret-read", spelling: "bash.secret.cat", reason: "..." }
}
```

- `classify(event, ctx)` is pure: the filesystem arrives as the `ctx` port. It throws the
  shell's `ParseError` for a Bash command it cannot parse.
- `decide(actions, actor, table?)` evaluates each action for each candidate class with
  authority's `evaluate` and keeps the strictest verdict.
- `handle(stdin, env, port)` is the whole hook: it never throws and returns the stdout and
  log lines for the bin to write.
- `nodeContext(home)` reads through `realpathSync.native`, so on a case-insensitive filesystem
  `~/.NPMRC` resolves to the guarded `~/.npmrc`.

## Spellings

`SPELLINGS` lists every id the classifier emits, each with the remedy the deny reason ends with.
Every id has a test fixture.

| Family | Action | Spellings | Example |
|---|---|---|---|
| secret | `secret-read` | `read.secret`, `read.secret-symlink`, `grep.secret`, and 22 `bash.secret.*` ids: `cat`, `head-tail-less`, `grep`, `cp-mv`, `encode`, `redirect-in`, `here-string`, `subshell`, `absolute`, `home-relative`, `symlink`, `link-then-read`, `var-indirection`, `quoting`, `glob`, `sh-c`, `xargs`, `inline-interpreter`, `heredoc-shell`, `script-by-path`, `keychain`, `mention` | `base64 < ~/.npmrc` |
| config | `authority-config` | `write.config`, and `bash.config.*`: `redirect-out`, `tee`, `cp-mv-ln`, `in-place`, `remove`, `interpreter`, `git-hooks`, `git-config-hookspath`, `claude-cli`, `mention` | `sed -i '' 's/deny/allow/' ~/.claude/settings.json` |
| merge | `merge` | `bash.merge.*`: `gh-pr-merge`, `gh-api-merge`, `gh-api-merges`, `gh-api-graphql`, `curl-api`, `git-merge-protected`, `git-push-protected`, `git-push-implicit`, `git-push-all` | `gh pr merge 12 --squash` |
| release | `release` | `bash.release.*`: `npm-publish`, `pnpm-publish`, `yarn-bun-publish`, `changeset-publish`, `npm-registry-mutation`, `gh-release`, `gh-workflow-run`, `wrangler-deploy`, `version-packages-merge` | `pnpm exec changeset publish` |
| egress | `private-egress` | `bash.egress.*`: `gh-gist`, `curl-upload`, `wget-upload`, `httpie`, `raw-socket`, `remote-copy`, `cloud-copy`, `git-push-url` | `curl -d @report.json https://collect.example.com/in` |

The guarded paths are `GUARDED_PATHS` (owner decision D4). The egress allowlist is GitHub,
the npm registry for reads, and loopback (owner decision D5).

## Install (owner only)

An agent never runs these steps. After the package is published:

1. Create `~/.claude/hooks/authority-guard/`, run `npm init -y` and
   `npm i @titan-design/tool-guard@<version>` there. Pinning keeps an upgrade deliberate and
   puts the guard inside a guarded config path.
2. Run `node ~/.claude/hooks/authority-guard/node_modules/@titan-design/tool-guard/dist/bin.js print-settings`
   and paste its output as a second element of `hooks.PreToolUse` in `~/.claude/settings.json`,
   after any existing entry.
3. Check that every other profile's `settings.json` is a symlink to it (`ls -l`), or add the
   same entry there.
4. From your own terminal, pipe a Read event for `$HOME/.npmrc` into `<bin> hook`; expect a
   deny and one log line.

## `@titan-design/tool-guard/shell`

```ts
import { extractCommands, parseGit } from "@titan-design/tool-guard/shell";

const commands = extractCommands('F=~/.x; cd /repo && git -C sub push origin "$F"', {
  cwd: "/work",
  home: "/home/you",
});
// [{ name: "git", path: "git", args: [...], env: {}, redirects: [], dir: "/repo", wrapping: [],
//    next: null, prev: "&&", negated: false, chain: { start: ";" } }]
const inv = parseGit(commands[0].args, commands[0].dir, "/home/you");
// inv.dir === "/repo/sub", inv.sub === "push"
```

- `tokenize(src)` returns words, operators, redirections (with their targets and heredoc
  bodies) and process substitutions. Throws `ParseError` on unterminated quoting.
- `extractCommands(src, { cwd, home })` returns every simple command the shell would run,
  each with its working directory. Literal assignments (`F=~/.x; cat "$F"`) and `$HOME` are
  expanded; anything computed stays `dynamic`. Each command also records how it was reached
  (`wrapping`: a subshell, `sh -c`, `eval`, `xargs`, a heredoc or pipe into a shell, `find -exec`),
  its command word as typed (`path`), the operators joining it to the commands before and after
  it (`prev`, `next`), whether a `!` negates its pipeline (`negated`), and the operator that
  started its `&&` chain (`chain`).
- `parseGit` and `splitArgs` read git's global options and flag clusters.

Nothing here touches the filesystem, the environment or a clock.

Ported from the owner's git-safety PreToolUse hook, with four additions:

1. Redirect targets are kept.
2. Heredoc bodies are kept.
3. `$'...'` strings are decoded.
4. Literal variables are tracked within one command string.

## Preference family

```ts
import { checkPreferences } from "@titan-design/tool-guard";
import { extractCommands } from "@titan-design/tool-guard/shell";

checkPreferences(extractCommands('bash -c "pkill -f vite"'), { seat: false });
// [{ id: "R86", message: "Kill only a process you started, by the PID you recorded, ..." }]
```

`checkPreferences(commands, ctx)` checks commands parsed by `extractCommands` against
`PREFERENCES`, a table of house rules that are not authority actions. It returns one
`{ id, message }` per broken row, in table order; each message is one sentence saying what to
do instead. Commands nested in `bash -c`, `eval`, heredocs, substitutions and wrappers count.

| Row | Matches | Passes |
|---|---|---|
| R86 | `pkill` without `-P`, `killall`, `kill` fed by `pgrep` or `pidof` | `pkill -P <pid>`, `kill <pid>` |
| R50 | a publish the release family classifies | `--dry-run`, `npm pack` |
| R31 | a merge, release, deploy, branch delete or tag push beside another command | the same command alone, or after `cd` |
| R127 | `gh run watch`, `gh pr checks --watch`, a CI read beside `sleep` or `watch` | a single `gh pr checks` |
| R133 | a merge the merge family classifies, when `ctx.seat` | `seat-merge`, any merge outside a seat |
| R64 | `active-work` with `XDG_DATA_HOME` set and no `ACTIVE_ROOT` | `ACTIVE_ROOT=<dir> active-work` |
| R164 | git `--no-verify`, `commit -n`, `-c core.hooksPath=` | `-m "--no-verify"`, `push -n` |

The checker is pure. A shell loop's keywords never reach the command list, so R127 reads a
`sleep` beside a CI read as the loop. The merge spellings that need the checked-out branch
(`git merge`, a bare `git push`) are skipped, since reading it needs the filesystem.
`checkPreferences` only reports; no hook blocks on a preference hit yet.
