---
"@titan-design/tool-guard": patch
---

Deny GitHub REST writes to rulesets (repos, repositories/<id>, orgs, enterprises) and to branch protection on any branch, through gh api, curl, wget or httpie, as `authority-config` (`bash.config.gh-api-ruleset`, `bash.config.curl-api-ruleset`).
