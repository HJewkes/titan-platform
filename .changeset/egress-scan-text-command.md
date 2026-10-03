---
"@titan-design/egress-scan": minor
---

Add `titan-egress-scan text [--file <path>]`, which scans free text from stdin or a file (a PR title, body or branch name) with the generic rules and private terms. Findings are `line:col` plus the rule id, never the matched text; exit codes match `range` and `pre-push`. The library gains `scanText` and `locateRules`, and `CliIo` gains `readFile`.
