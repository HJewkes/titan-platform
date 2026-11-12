---
"@titan-design/github": minor
"@titan-design/factory": patch
---

`@titan-design/github` adds `GitHubPort.listBranchCommits(repo, base, head)`, which reads a branch's own commits (sha, author and committer logins, message) and the paths they change from the compare API with no PR, and `GitHubPort.actorLogin()`, the login the port writes as. The wire gains `compareCommits`; the fake answers it from `compares`, whose entries take an optional `commits` list.

Factory's consumer bump sweep now reuses a leftover bump branch with no PR when every commit on it is the sweep's own: authored and committed by the port's login, with the sweep's per-file bump message, and changing only the manifests and lockfile this bump writes. It writes the fresh bump on top and opens the PR, checking the branch again before it opens. Any other branch still fails closed with `LeftoverBumpBranchError`. Nothing is force-pushed or deleted.
