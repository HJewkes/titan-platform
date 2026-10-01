---
"@titan-design/github": minor
---

`githubPort(wire, { login })` takes the bot login that `upsertComment` owns comments as, so it works under a GitHub App installation token where `GET /user` is 403. A marker line with trailing whitespace now counts as a match.
