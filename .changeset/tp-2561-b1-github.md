---
"@titan-design/github": minor
---

Add `octokitWire`, the GitHub port over Octokit for long-running services (TP-2561 b1). It behaves like this:
- `@octokit/plugin-throttling` waits out rate limits and spaces writes.
- `@octokit/plugin-retry` retries GET and HEAD only.
- ETag reads keep the existing cache and 304 rules.
- The token comes from `gh auth token`, is held in memory, and is re-read once on a 401.

New exports: `octokitClient`, `sharedOctokit`, `octokitRest`, `GitHubRequestError`, the `Rest` and `Fields` types, and `appInstallationTokenOverHttp`. `client.budget()` reports the live rate windows and throttle cooldowns. `ghCliWire` is unchanged.
