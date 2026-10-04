---
"@titan-design/github": minor
---

Create check runs under a GitHub App installation token. Add `appInstallationToken` (an RS256 JWT signed with `node:crypto`, exchanged at `/app/installations/{id}/access_tokens`) and `signAppJwt`; add `createCheckRun` to the wire, the port and `fakeGitHub`, which records the run under a configurable `appId`. `conclusion` is typed `success`, `failure` or `action_required` and any other value throws `GitHubInputError` before a wire call. `ghCliWire` takes an `appToken` provider and passes the token as `GH_TOKEN` in the child env of that one call; `GhExecOptions` gains `env`. Errors never contain the token, the JWT or the PEM.
