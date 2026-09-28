# egress-scan

**Tier 0 · primitives.** No dependencies at all.

```sh
npm install @titan-design/egress-scan
```

## The problem it solves

Public repos receive text written on a private machine. A path copied from a terminal
carries the owner's login, a note can point into the active-work data directory, and a
private project name can slip into a commit message. GitHub push protection catches
credentials, but nothing caught these.

The primitive is `scan`: it reads git patch text and returns findings of the form
`{ location, rule, termIndex? }`. No field carries the matched text, so the report is safe
to print in public CI logs. `formatReport` takes findings and counts, never scanned text,
so it cannot echo a line by construction.

## When to reach for it

A pre-push hook or a CI job that must refuse content before it reaches a public remote.
Use the `titan-egress-scan` bin for both. Use the library entry when you already hold the
patch text: the caller runs git, reads the private term list and the allow file, and passes
text in.
To mask credentials for display, use the redactor in [queue-mirror](./queue-mirror.md);
it masks rather than locates.

## Example

Verified against 0.0.0 (unreleased).

```ts
import { formatReport, parseCommit, parseTerms, scan } from "@titan-design/egress-scan";

// Assembled at runtime so this page never trips the scanner itself.
const home = ["", "home", "dana"].join("/");
const show = [
  "Add setup notes\0",
  "diff --git a/docs/setup.md b/docs/setup.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/setup.md",
  "@@ -0,0 +1,2 @@",
  "+Clone the repo.",
  `+cd ${home}/src/zq-demo`,
].join("\n");

const result = scan([parseCommit("0123456789abcdef", show)], { terms: parseTerms("# mine\nzq-demo") });
formatReport(result.findings, { ...result, termsLoaded: true });
// commit 0123456 docs/setup.md:2 home-path
// commit 0123456 docs/setup.md:2 private-term #2
// egress-scan: 2 findings (home-path 1, aw-data-path 0, private-term 1)
// allowed: home-path 0, aw-data-path 0
// binary files skipped: 0
// private term list: loaded
```

## Rules

| Rule | Matches | Allowable |
|---|---|---|
| `home-path` | `/Users/<seg>`, `/home/<seg>`, `C:\Users\<seg>` and `C:/Users/<seg>` with the root in any case, also inside `file://` URLs with or without a host, and JSON-escaped | yes |
| `aw-data-path` | the active-work data directory in each default shape: the macOS Application Support directory, the XDG data directory under `.local/share`, and Windows local `AppData`, with any prefix (`~`, `$HOME` or absolute) | yes |
| `private-term` | each line of the private term list | never |

A `home-path` segment is exempt when it is a placeholder: `Shared`, `runner`, `you`,
`your-name`, `user`, `username`, `me`, `example`, `name`, `x`, `alice` or `bob` (any case),
or any segment written `<...>`, `{...}` or starting with `$`. The list is
`PLACEHOLDER_SEGMENTS`. A path segment must follow the root, and the root must start a path,
so `app/home/page.tsx` and `/UsersGuide` do not match.

The private term list is UTF-8 with one term per line. `#` starts a comment and blank lines
are skipped. A plain term matches case-insensitively on Unicode word boundaries. A line
starting `re:` is a regular expression compiled with the `iu` flags. A term that matches the
empty string, such as `re:.*`, is rejected, because it would match every line. `termIndex` is the
term's line number, so the owner can find it locally without the report naming it.

## The allow file

`.egress-allow` at the repo root holds one `<glob> <rule-id> <reason>` entry per line. The
glob is anchored to the repo-relative path: `**` spans directories, `*` and `?` do not. The
glob must name at least one literal path segment, one with no wildcard, so `**`, `*`,
`**/*` and `*/*.md` are rejected: they would allow a rule across the whole tree. The
reason must name a task id such as `TP-405`. An entry suppresses only its rule, only in
matching files, and every suppression is counted in the report's `allowed:` line. There
are no inline suppression comments.

## Command line

The package ships a `titan-egress-scan` bin. It needs git 2.24 or later.

```sh
titan-egress-scan pre-push <remote>     # the commits a push sends; reads git's pre-push stdin
titan-egress-scan range <base> <head>   # every commit in base..head, for CI
titan-egress-scan tree                  # every tracked file at HEAD, once at rollout
titan-egress-scan install-hook          # write the pre-push hook
```

Exit codes are 0 clean, 1 findings, 2 usage or configuration error. Findings go to stdout;
notices and errors go to stderr.

- **What a push scans.** `pre-push` skips ref deletions and scans `remote..local` for an
  existing branch. For a new branch it scans only the commits no ref of that remote has.
  `range` with an all-zero base scans the head commit alone. Each commit is read with
  `git show -c`, so a merge commit's combined diff is scanned too. After a merge of the main
  branch, a line already on main can be reported again in a file both sides changed.
- **Arguments.** Shas on pre-push stdin must be full hex shas. A `range` base or head must be
  a hex sha or a ref name, and a remote name must not start with a dash. A bad value exits 2
  and the message names its position, never its value.
- **The private term list.** The bin reads `$TITAN_EGRESS_TERMS`, else
  `${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms`. When `CI` is set it never
  looks. Locally a missing list prints a notice and the scan continues, and
  `TITAN_EGRESS_REQUIRE_TERMS=1` turns that into exit 2.
- **The allow file.** The bin reads `.egress-allow` from the repo root; a malformed file exits 2.
- **The hook.** `install-hook` writes into the directory `git rev-parse --git-path hooks`
  names. That is `core.hooksPath` when set, otherwise the common git directory, which every
  linked worktree shares. It never sets `core.hooksPath` and never replaces a `pre-push` it
  did not write, and it does nothing when `CI` is set. The hook runs the pushing worktree's
  `node_modules/.bin/titan-egress-scan`. It falls back to the package's built `dist/bin.js`,
  because pnpm skips the `.bin` link for a workspace package that was unbuilt at install.
  It fails closed when neither exists.

In a consumer repo, add the package as a devDependency with
`"prepare": "titan-egress-scan install-hook"`, and run `range` in a CI job with the pull
request's base and head shas. titan-platform builds the package inside `prepare` instead;
see [Working in the repo](/guides/contributing#the-egress-scan).

## What it deliberately does not do

The library entry does not run git, read files or look at the environment; the bin does,
which keeps the core the same under a hook and under CI. It does not scan for credentials, which GitHub
push protection covers. It cannot see text published through other channels: pull request
titles and bodies, issue comments and release notes.

CI runs after a push, so for a public repo a CI job is a merge gate, not an egress control.
Only a pre-push hook stops the text before it leaves the machine.

## Gotchas

`parseAllow` throws `AllowFileError` on any malformed line, naming the line. Fail the scan
on it as a configuration error. Never skip the bad line and keep the rest.

`parseTerms` throws `TermFileError` for an invalid `re:` line. The message names the line
number only; the regex engine's own message quotes the pattern, so it is dropped.

A file whose path trips a rule is reported as `file #<n>`, its position in the diff, for
both the path finding and its line findings. Its path would otherwise leak through the
location.

Scan each commit of a push, not the diff between its endpoints. A leak added in one commit
and removed in the next is still in the pushed history. `parseCommit` expects
`git show -c -U0 --format=%B%x00` output: the message, a NUL, then the patch.

Combined merge diffs (`diff --cc`) are parsed: a line counts as added when any parent lacks
it and no column marks it removed.

## Where it came from

New in TP-405. Nothing in the platform located policy text in diffs before; the redactors
in queue-mirror and factory mask credentials for display, which is a different job.
