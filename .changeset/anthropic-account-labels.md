---
"@titan-design/anthropic-account": patch
---

`poll` reads `ANTHROPIC_ACCOUNT_LABELS`, a comma-separated list of account labels. A profile outside the list whose login is missing or refused now prints a stderr warning and no longer fails the run, so a stray config dir stops failing the timer. Failures on listed accounts, and HTTP or refresh failures anywhere, still exit non-zero. Unset, behavior is unchanged.
