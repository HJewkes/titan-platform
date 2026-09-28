# @titan-design/egress-scan

Finds text that must not leave the machine for a public repo: absolute home paths, paths
into the active-work data directory, and terms from a private list kept outside any repo.
A finding names its location and rule id and nothing else, so a report is safe to print
in public CI logs.

Tier 0 of the titan-platform DAG, with no dependencies. The library entry uses no Node
built-ins: callers run git and read files, then hand the text in. The `titan-egress-scan`
bin does that work for a pre-push hook and a CI job. Tracked by TP-405.

## Command line

```sh
titan-egress-scan pre-push <remote>     # the commits a push sends; reads git's pre-push stdin
titan-egress-scan range <base> <head>   # every commit in base..head, for CI
titan-egress-scan tree                  # every tracked file at HEAD, once per repo at rollout
titan-egress-scan install-hook          # write the pre-push hook
```

Exit codes: 0 clean, 1 findings, 2 usage or configuration error. Findings go to stdout,
notices and errors to stderr.

- **Ranges.** `pre-push` skips ref deletions, scans `remote..local` for an existing branch,
  and for a new branch scans only the commits no ref of that remote has. `range` with an
  all-zero base scans the head commit alone. Each commit is read with `git show -c`, so a
  merge commit's combined diff is scanned too.
- **Arguments.** Shas on pre-push stdin must be full hex shas, a `range` base or head must be
  a hex sha or a ref name, and a remote name must not start with a dash or hold whitespace.
  A bad value exits 2 with its position, never its value. Every revision reaches git after
  `--end-of-options`, so the bin needs git 2.24 or later. A help flag after the command
  exits 2 rather than skipping the scan.
- **Private term list.** `$TITAN_EGRESS_TERMS`, else
  `${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms`. When `CI` is set it is never
  looked up. Locally a missing list prints a notice and the scan continues;
  `TITAN_EGRESS_REQUIRE_TERMS=1` makes that exit 2. A list readable by other users prints a
  notice and still loads.
- **Allow file.** `.egress-allow` at the repo root. A malformed file exits 2.
- **Hook.** `install-hook` writes `hooks/pre-push` into the directory
  `git rev-parse --git-path hooks` names: `core.hooksPath` when set, otherwise the common git
  directory, which every linked worktree shares. It never sets `core.hooksPath`, never
  replaces a `pre-push` it did not write (exit 2 with a chaining hint), and does nothing when
  `CI` is set. The hook runs the pushing worktree's `node_modules/.bin/titan-egress-scan`,
  falls back to the package's built `dist/bin.js`, and fails closed when neither exists.

## Scanning a push

```ts
import { formatReport, parseAllow, parseCommit, parseTerms, scan } from "@titan-design/egress-scan";

// Each commit's text from `git show -c -U0 --format=%B%x00 --no-color --no-ext-diff <sha>`.
const sources = commits.map(({ sha, text }) => parseCommit(sha, text));
const result = scan(sources, { terms: parseTerms(termFileText), allow: parseAllow(allowFileText) });
for (const line of formatReport(result.findings, { ...result, termsLoaded: true })) console.log(line);
process.exitCode = result.findings.length > 0 ? 1 : 0;
```

`scan` reads added lines, the paths of new, renamed and copied files, and commit messages.
Removed lines are ignored and binary files are counted and skipped. Scan each commit, not
only the range endpoints: a leak added and then removed is still in the pushed history.

## Rules

- `home-path`: `/Users/<seg>`, `/home/<seg>` and `C:\Users\<seg>`, root in any case, also
  inside `file://` URLs with any host and JSON-escaped. Placeholder segments are exempt: `PLACEHOLDER_SEGMENTS`, and any
  segment written `<...>`, `{...}` or starting with `$`.
- `aw-data-path`: the active-work data directory in its macOS, XDG and Windows default
  shapes, with any prefix.
- `private-term`: one per line of the term list. `#` comments and blank lines are skipped.
  A plain term matches case-insensitively on word boundaries; a `re:` line is a regex
  compiled with `iu`. A term that matches the empty string is rejected. A finding carries `termIndex`, the term's line in the file.

## Allow file

`.egress-allow` holds `<glob> <rule-id> <reason>` lines. The reason must name a task id
such as `TP-405`, and the glob must name at least one literal path segment.
`private-term` is never allowable. `parseAllow` throws `AllowFileError`
on any malformed line; a caller must fail the scan on it, never fall back to an empty list.

## Safety

No finding, report line or error carries matched text. `TermFileError` names the term's
line number only, even for an invalid regex. A file whose path trips a rule is reported as
`file #<n>`, because its path would otherwise leak through the location.
