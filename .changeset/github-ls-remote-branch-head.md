---
"@titan-design/github": minor
---

Adds `lsRemoteBranchHead(exec, remoteUrl, branch, options)`: `git ls-remote` for `refs/heads/<branch>`, with the same credential-in-env, URL and failure rules as `lsRemotePullHead`, so a branch tip has git's transport as a second source too. A branch name that is not a plain ref name is refused before git runs.
