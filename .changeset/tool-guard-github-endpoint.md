---
"@titan-design/tool-guard": patch
---

Add an internal `mayReachGitHubApi` predicate: a URL word whose host is known only at run time, or that names `api.github.com` with a run-time path or query, may reach a GitHub merge endpoint (TP-2728 a); not wired yet.
