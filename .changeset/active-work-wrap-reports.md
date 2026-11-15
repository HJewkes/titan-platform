---
"@titan-design/active-work": minor
---

`wrap` now requires exactly one of `--reports` (a JSON array of `{ref, answer}`) or `--no-reports`, and records `reports` or `no_reports: true` in the session frontmatter. The agent-chat completion hook passes `--no-reports`.
