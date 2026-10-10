---
"@titan-design/github": minor
---

Add `formatSquashMessage` and the `titan-squash-message` bin: a pure, deterministic squash commit message built from the PR title, body, task ids and commits, laid out as `## Summary`, `## Changes` (one bolded bullet per commit) and `Refs:`. Author markdown passes through as written: only plain commit-body paragraphs are joined onto one line. It strips Co-authored-by and Signed-off-by trailers, standalone email addresses (never inside code, URLs or ssh remotes) and the Claude Code line, recognises GitHub's `---------` separator and `* ` commit headers only in a commit GitHub squash-merged, and drops merges of main. Re-formatting its own output changes nothing.
