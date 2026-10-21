---
"@titan-design/github": minor
---

Add `revalidateRef(repo, branch, etag)` and `revalidateRulesets(repo, etag)` to `GitHubPort` and `GitHubWire`, beside `revalidateOpenPrs`. Both send `If-None-Match` and answer `notModified` on a 304. `revalidateRulesets` maps each ruleset id to its `updated_at`, reading a ruleset's detail only when its list row lacks one, and answers `unreadable` for a free-plan 403.
