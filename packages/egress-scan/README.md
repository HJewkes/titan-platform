# @titan-design/egress-scan

Finds text that must not leave the machine for a public repo: absolute home paths, paths
into the active-work data directory, terms from a private list kept outside any repo, and
credential tokens.
A finding names its location and rule id and nothing else, so a report is safe to print
in public CI logs.

Tier 0 of the titan-platform DAG, with no dependencies. The library entry uses no Node
built-ins: callers run git and read files, then hand the text in. The `titan-egress-scan`
bin does that work for a pre-push hook and a CI job. Tracked by TP-405.

## Command line

```sh
titan-egress-scan pre-push <remote> [<url>]  # the commits a push sends; reads git's pre-push stdin
titan-egress-scan range <base> <head>   # every commit in base..head, for CI
titan-egress-scan tree                  # every tracked file at HEAD, once per repo at rollout
titan-egress-scan text [--file <path>]  # free text from stdin or a file: PR title, body, branch name
titan-egress-scan install-hook          # write the pre-push hook
```

Exit codes: 0 clean, 1 findings, 2 usage or configuration error. Findings go to stdout,
notices and errors to stderr.

- **Ranges.** `pre-push` skips ref deletions, scans `remote..local` for an existing branch minus the commits the remote itself advertises (`git ls-remote` of the push URL git passes as the second argument; local tracking refs are never trusted, and if that URL is missing or does not answer within 20 seconds the plain `remote..local` is scanned),
  and for a new branch scans only the commits no ref of that remote has. `range` with an
  all-zero base scans the head commit alone. A merge commit is diffed against each parent
  in turn (`--diff-merges=separate`), because git's combined diff ignores `--text`; a path
  both diffs name is reported once. The message is read with `--encoding=UTF-8`, so
  `i18n.logOutputEncoding` cannot re-encode it past the rules.
- **Text.** `text` scans free text (a PR title, body or branch name) with the generic rules and
  the private term list, for the CC-269 and CC-270 callers. It reads stdin, or `--file <path>`
  (never both); an unreadable file exits 2. A finding is `<line>:<col> <rule>[ #<term>][ <kind>]`, never
  the matched text; `\r\n` counts as one line break, and a column counts UTF-16 units from 1.
  Input over the 128 MiB limit exits 2. It needs no git repo and applies no allow file, since
  prose has no path to allow. Exit codes match `range` and `pre-push`.
- **Idents and ref names.** Each scanned commit's raw author and committer name and email are
  scanned too, and a finding names the field (`commit <sha> author.name`, `author.email`,
  `committer.name`, `committer.email`). `pre-push` also scans the local and remote ref names on
  each stdin line, so a branch or tag named after a private term is refused as
  `push line <n> local ref` or `push line <n> remote ref`. A ref deletion is not scanned, so a
  leaked ref can still be deleted. Idents and ref names are never allowable.
- **Binary files are scanned as text.** Every `git show` and `git diff` passes `--text`, so a
  file git calls binary (one NUL byte is enough) still yields its lines, and the report's
  `binary files skipped` stays 0; if git ever prints a file as binary anyway, the scan exits 2.
  There is no opt-out, since an opt-out would be a bypass.
  Matching is on the bytes decoded as UTF-8: a term written in UTF-16 or another encoding is
  not matched. **UTF-16 text is not scanned**: a UTF-16LE or UTF-16BE file passes even
  with `--text`, because its NUL-interleaved bytes never decode to the term.
- **Size limit.** A commit whose patch text is over 128 MiB (`MAX_PATCH_BYTES`) exits 2 with
  one line naming its short sha and the limit. `tree` has the same limit on the whole tree's
  patch text and exits 2 with one line naming `tree` and the limit. GitHub itself refuses a file over 100 MiB.
- **Arguments.** Shas on pre-push stdin must be full hex shas, a `range` base or head must be
  a hex sha or a ref name, and a remote name must not start with a dash or hold whitespace.
  A bad value exits 2 with its position, never its value. Every revision reaches git after
  `--end-of-options`, so the bin needs git 2.24 or later. A help flag after the command
  exits 2 rather than skipping the scan.
- **Private term list.** `$TITAN_EGRESS_TERMS`, else
  `${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms`. When `CI` is set it is never
  looked up. Locally a missing list prints a notice and the scan continues. A list readable by
  other users prints a notice and still loads.
- **`TITAN_EGRESS_REQUIRE_TERMS=1` is the agent-hook switch.** It fails closed: `CI` no longer
  skips the list, and a missing, unreadable or term-less list (only comments and blank lines)
  exits 2 with a message naming the variable. The value is read case-insensitively and trimmed:
  `1`, `true`, `yes`, `on` are on; empty, `0`, `false`, `no`, `off` are off; anything else exits 2.
  No other variable turns it back into a pass.
- **Allow file.** `.egress-allow` at the repo root. A malformed file exits 2.
- **Hook.** `install-hook` writes `hooks/pre-push` into the directory
  `git rev-parse --git-path hooks` names: `core.hooksPath` when set, otherwise the common git
  directory, which every linked worktree shares. It never sets `core.hooksPath`, never
  replaces a `pre-push` it did not write (exit 2 with a chaining hint), and does nothing when
  `CI` is set. The hook runs the first scanner it finds, in this order: (1) the pushing
  worktree's `node_modules/.bin/titan-egress-scan`, then its
  `node_modules/@titan-design/egress-scan/dist/bin.js`; (2) the same two paths in the main
  checkout, the parent of `git rev-parse --git-common-dir`; (3) `titan-egress-scan` on `PATH`,
  which considers only absolute `PATH` entries, so a `.` or empty segment never runs a
  scanner planted in the pushed tree.
  A linked worktree without `node_modules` therefore pushes when the main checkout or `PATH`
  has the scanner. When none is found the hook exits 1 (fail closed) and names the three places
  it looked, plus `pnpm install && pnpm build` and `npm i -g @titan-design/egress-scan`.

## Scanning a push

```ts
import { formatReport, parseAllow, parseCommit, parseTerms, scan } from "@titan-design/egress-scan";

// Each commit's text from `git show --text -U0 --encoding=UTF-8 --format=%B%x00 --no-color --no-ext-diff <sha>`.
const sources = commits.map(({ sha, text }) => parseCommit(sha, text));
const result = scan(sources, { terms: parseTerms(termFileText), allow: parseAllow(allowFileText) });
for (const line of formatReport(result.findings, { ...result, termsLoaded: true })) console.log(line);
process.exitCode = result.findings.length > 0 ? 1 : 0;
```

`scan` reads added lines, the paths of new, renamed and copied files, and commit messages.
Removed lines are ignored. A patch made without `--text` shows a binary file as
`Binary files ... differ`, which `scan` counts and skips, so pass `--text` as the bin does. A merge's combined diff
ignores `--text`, so for a merge read the message with `--no-patch --format=%B` and the patch
with `--diff-merges=separate --format=`, and pass the patch to `parseDiff`. Scan each commit, not
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
- `credential-token`: a credential shape, and the finding's `kind` names which: `github`
  (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), `anthropic` (`sk-ant-`),
  `aws-access-key` (`AKIA`/`ASIA` plus 16), `slack` (`xox[abprs]-`) and `private-key` (a PEM
  private-key header). Each shape checks its length and charset and must stand alone, so a bare
  prefix, a truncated token, a git sha or a base64 run does not match. `/`, `_`, a `\n`-style
  escape and a `%XX` escape count as separators, so a token in a URL path, a variable name or
  a JSON log line still matches. Each kind is reported
  once per line. Build test fixtures at runtime (`"ghp_" + "A".repeat(36)`).

## Allow file

`.egress-allow` holds `<glob> <rule-id> <reason>` lines. The reason must name a task id
such as `TP-405`, and the glob must name at least one literal path segment.
Braces expand (`docs/{a,b}.md`), and every alternative must name a literal segment. A glob
that expands past 256 alternatives is malformed. A backslash is not an escape; it matches a
literal backslash.
`private-term` and `credential-token` are never allowable. `parseAllow` throws `AllowFileError`
on any malformed line; a caller must fail the scan on it, never fall back to an empty list.

## Safety

No finding, report line or error carries matched text. `TermFileError` names the term's
line number only, even for an invalid regex. A file whose path trips a rule is reported as
`file #<n>`, because its path would otherwise leak through the location.
