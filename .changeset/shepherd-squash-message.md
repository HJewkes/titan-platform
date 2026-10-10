---
"@titan-design/github": minor
"@titan-design/factory": minor
---

Pass the formatted squash message on every land merge. `GitHubPort.merge` takes an optional `{ subject, body }` that the wire sends as `commit_title` and `commit_message`; the port gains `getSquashSource` (title, body and commit messages) so a caller can build the `formatSquashMessage` input. The factory's land merge step formats the PR's title, body and commits with the run's task id and merges with that message, falling back to the plain title and an empty body (and a warning) when formatting throws.
