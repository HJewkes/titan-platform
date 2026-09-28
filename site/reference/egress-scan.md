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
The caller runs git, reads the private term list and the allow file, and passes text in.
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
| `home-path` | `/Users/<seg>`, `/home/<seg>`, `C:\Users\<seg>` and `C:/Users/<seg>`, also inside `file://` URLs and JSON-escaped | yes |
| `aw-data-path` | the active-work data directory in each default shape: the macOS Application Support directory, the XDG data directory under `.local/share`, and Windows local `AppData`, with any prefix (`~`, `$HOME` or absolute) | yes |
| `private-term` | each line of the private term list | never |

A `home-path` segment is exempt when it is a placeholder: `Shared`, `runner`, `you`,
`your-name`, `user`, `username`, `me`, `example`, `name`, `x`, `alice` or `bob` (any case),
or any segment written `<...>`, `{...}` or starting with `$`. The list is
`PLACEHOLDER_SEGMENTS`. A path segment must follow the root, and the root must start a path,
so `app/home/page.tsx` and `/UsersGuide` do not match.

The private term list is UTF-8 with one term per line. `#` starts a comment and blank lines
are skipped. A plain term matches case-insensitively on Unicode word boundaries. A line
starting `re:` is a regular expression compiled with the `iu` flags. `termIndex` is the
term's line number, so the owner can find it locally without the report naming it.

## The allow file

`.egress-allow` at the repo root holds one `<glob> <rule-id> <reason>` entry per line. The
glob is anchored to the repo-relative path: `**` spans directories, `*` and `?` do not. The
reason must name a task id such as `TP-405`. An entry suppresses only its rule, only in
matching files, and every suppression is counted in the report's `allowed:` line. There
are no inline suppression comments.

## What it deliberately does not do

It does not run git, read files or look at the environment; the caller does, which keeps
the core the same under a hook and under CI. It does not scan for credentials, which GitHub
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
`git show -U0 --format=%B%x00` output: the message, a NUL, then the patch.

Combined merge diffs (`diff --cc`) are parsed: a line counts as added when any parent lacks
it and no column marks it removed.

## Where it came from

New in TP-405. Nothing in the platform located policy text in diffs before; the redactors
in queue-mirror and factory mask credentials for display, which is a different job.
