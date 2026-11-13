---
"@titan-design/github": minor
"@titan-design/factory": patch
---

`GhError` carries a closed `transport` kind (`server-5xx`, `no-connection`, `empty-or-cut-body`, `read-timeout` or `none`), set where the error is raised: from the HTTP status, Octokit's failed connection, the deadline that fired (a read only; a timed-out write is `none`), or, for `gh api` failing before any answer, from its output at one boundary inside the package. Shepherd's `gh-api-5xx` class now reads that field instead of matching `gh`'s stderr; rows written before TP-5446 S11b still read their text.
