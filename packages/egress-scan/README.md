# @titan-design/egress-scan

Finds text that must not leave the machine for a public repo: absolute home paths, paths
into the active-work data directory, and terms from a private list kept outside any repo.
A finding names its location and rule id and nothing else, so a report is safe to print
in public CI logs.

Tier 0 of the titan-platform DAG. No dependencies, no Node built-ins: callers run git and
read files, then hand the text in. Tracked by TP-405.

## Scanning a push

```ts
import { formatReport, parseAllow, parseCommit, parseTerms, scan } from "@titan-design/egress-scan";

// Each commit's text from `git show -U0 --format=%B%x00 --no-color --no-ext-diff <sha>`.
const sources = commits.map(({ sha, text }) => parseCommit(sha, text));
const result = scan(sources, { terms: parseTerms(termFileText), allow: parseAllow(allowFileText) });
for (const line of formatReport(result.findings, { ...result, termsLoaded: true })) console.log(line);
process.exitCode = result.findings.length > 0 ? 1 : 0;
```

`scan` reads added lines, the paths of new, renamed and copied files, and commit messages.
Removed lines are ignored and binary files are counted and skipped. Scan each commit, not
only the range endpoints: a leak added and then removed is still in the pushed history.

## Rules

- `home-path`: `/Users/<seg>`, `/home/<seg>` and `C:\Users\<seg>`, also inside `file://`
  URLs and JSON-escaped. Placeholder segments are exempt: `PLACEHOLDER_SEGMENTS`, and any
  segment written `<...>`, `{...}` or starting with `$`.
- `aw-data-path`: the active-work data directory in its macOS, XDG and Windows default
  shapes, with any prefix.
- `private-term`: one per line of the term list. `#` comments and blank lines are skipped.
  A plain term matches case-insensitively on word boundaries; a `re:` line is a regex
  compiled with `iu`. A finding carries `termIndex`, the term's line in the file.

## Allow file

`.egress-allow` holds `<glob> <rule-id> <reason>` lines. The reason must name a task id
such as `TP-405`. `private-term` is never allowable. `parseAllow` throws `AllowFileError`
on any malformed line; a caller must fail the scan on it, never fall back to an empty list.

## Safety

No finding, report line or error carries matched text. `TermFileError` names the term's
line number only, even for an invalid regex. A file whose path trips a rule is reported as
`file #<n>`, because its path would otherwise leak through the location.
