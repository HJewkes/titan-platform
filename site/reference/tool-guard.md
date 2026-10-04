# tool-guard

**Tier 0.** No titan dependencies yet.

```sh
npm install @titan-design/tool-guard
```

Status: placeholder. Tracked by TP-488. Replace every section below before the package
ships its first real release.

## The problem it solves

POSIX shell tokenizer and command extraction for tool-call guards

Say what was hard before this package existed, and name the one primitive it adds.

## When to reach for it

The situations that should send a reader here, and the neighbouring packages that cover the
situations that should not.

## Example

The smallest program that shows the primitive working. Note the version it was verified
against.

```ts
import {} from "@titan-design/tool-guard";
```

## Preference family

`checkPreferences(commands, ctx)` checks the commands `extractCommands` returns against
`PREFERENCES`, a table of house rules that are not authority actions, and returns
`{ id, message }[]`: one entry per broken row, in table order. Each message is one sentence
that tells the agent what to do instead. `ctx.seat` says whether the session is a seat, which
only R133 reads. The checker reads no filesystem, environment or clock.

```ts
import { checkPreferences } from "@titan-design/tool-guard";
import { extractCommands } from "@titan-design/tool-guard/shell";

const hits = checkPreferences(extractCommands("gh pr merge 12 --squash && git branch -D feat/x"), { seat: true });
// [{ id: "R31", message: "Run the merge, ... as its own Bash call, ..." },
//  { id: "R133", message: "Merge with `seat-merge ...`, ..." }]
```

| Row | Rule | Matches | Near miss that passes |
|---|---|---|---|
| R86 | Stop only servers you started, by PID | `pkill` without `-P`, `killall`, `kill` fed by `pgrep` or `pidof` | `pkill -P <pid>` |
| R50 | Never publish locally | a publish the release family classifies | `npm publish --dry-run` |
| R31 | A merge, branch delete, deploy or tag push runs as its own call | one of those beside another command | the same command after `cd` |
| R127 | Wait for CI with `ci-wait` | `gh run watch`, `gh pr checks --watch`, a CI read beside `sleep` or `watch` | `gh pr checks` alone |
| R133 | A seat merges only through `seat-merge` | a merge the merge family classifies, in a seat | the same merge outside a seat |
| R64 | Override the active-work root only with `ACTIVE_ROOT` | `XDG_DATA_HOME=` before `active-work` | `ACTIVE_ROOT=<dir> active-work` |
| R164 | Never skip hooks | git `--no-verify`, `commit -n`, `-c core.hooksPath=` | `git commit -m "--no-verify"` |

Commands nested in `bash -c`, `eval`, heredocs and substitutions count, because
`extractCommands` lists them. A shell loop's keywords never reach that list, so R127 reads a
`sleep` beside a CI read as a polling loop. The merge spellings that turn on the checked-out
branch (`git merge`, a bare `git push`) are skipped, since reading the branch needs the
filesystem.

## What it deliberately does not do

The scope this package refuses, so nobody files the same issue twice.

## Gotchas

The things that cost someone an afternoon: argument shapes that look interchangeable and
are not, lazy behaviour, errors that are returned rather than thrown.

## Where it came from

New, or extracted from somewhere. If it replaces an older approach, say what that was and
why it went.
