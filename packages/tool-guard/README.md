# @titan-design/tool-guard

Classifies Claude Code tool calls into guarded authority actions, with a POSIX shell tokenizer

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Status: private and unpublished while TP-403 lands in slices. TP-488 shipped the `./shell`
entry. TP-489 adds `parseHookEvent`, `classify` with the secret and config families,
`SPELLINGS` and `GUARDED_PATHS`. The merge, release and egress families, the decision, the hook
and the bin follow.

## `@titan-design/tool-guard/shell`

```ts
import { extractCommands, parseGit } from "@titan-design/tool-guard/shell";

const commands = extractCommands('F=~/.x; cd /repo && git -C sub push origin "$F"', {
  cwd: "/work",
  home: "/home/you",
});
// [{ name: "git", path: "git", args: [...], env: {}, redirects: [], dir: "/repo", wrapping: [], next: null }]
const inv = parseGit(commands[0].args, commands[0].dir, "/home/you");
// inv.dir === "/repo/sub", inv.sub === "push"
```

- `tokenize(src)` returns words, operators, redirections (with their targets and heredoc
  bodies) and process substitutions. Throws `ParseError` on unterminated quoting.
- `extractCommands(src, { cwd, home })` returns every simple command the shell would run,
  each with its working directory. Literal assignments (`F=~/.x; cat "$F"`) and `$HOME` are
  expanded; anything computed stays `dynamic`. Each command also records how it was reached
  (`wrapping`: a subshell, `sh -c`, `eval`, `xargs`, a heredoc or pipe into a shell, `find -exec`),
  its command word as typed (`path`), and the operator joining it to the next (`next`).
- `parseGit` and `splitArgs` read git's global options and flag clusters.

Nothing here touches the filesystem, the environment or a clock.

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
(`git merge`, a bare `git push`) are skipped, since reading it needs the filesystem. The hook
that blocks on a hit is a later slice.

Ported from the owner's git-safety PreToolUse hook, with four additions: redirect targets
and heredoc bodies are kept, `$'...'` strings are decoded, and literal variables are
tracked within one command string.
