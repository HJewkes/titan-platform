---
"@titan-design/github": minor
---

Add `formatSquashMessage` and the `titan-squash-message` bin: a pure, deterministic squash commit message built from the PR title, body, task ids and commits, laid out as `## Summary`, `## Changes` (one bolded bullet per commit) and `Refs:`. It strips Co-authored-by and Signed-off-by trailers, every email address, GitHub's `---------` separator and `* ` commit headers, and drops merges of main. Re-formatting its own output changes nothing.
