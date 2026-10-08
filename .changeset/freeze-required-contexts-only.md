---
"@titan-design/factory": patch
"@titan-design/github": minor
---

Shepherd judges a main commit by the base branch's required contexts (rulesets, then classic protection, with per-context app pins) instead of every Actions job. A red non-required job such as `release` records a warning and no longer freezes the repo; a repo with no rules, or a rules read that fails, keeps the all-checks rule. The github port gains `classicRequiredChecks` and `RequiredChecks.pins`.
