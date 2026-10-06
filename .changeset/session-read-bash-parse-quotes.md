---
"@titan-design/session-read": patch
---

Read git and gh intents only from unquoted simple commands. `parseGitIntent` and the `pr_create` signal no longer match text inside quotes, `echo` arguments or heredoc bodies, so `echo "gh pr merge 42"` records no merge and a commit message mentioning `git push` records no push. `EXTRACT_VERSION` is now 6, so stored intents re-extract on the next backfill.
