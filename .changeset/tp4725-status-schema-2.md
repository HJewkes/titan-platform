---
"@titan-design/anthropic-account": minor
---

`status --json` now prints `{ schema: 2, accounts }`, one `readAccounts` row per Anthropic login, in place of `{ profiles }`. `status --statusline` renders from the same rows, so `~/.claude` and a profile on one login are one cell under the profile's label.
