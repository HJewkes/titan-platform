---
"@titan-design/egress-scan": minor
---

Add the `credential-token` rule. It flags GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Anthropic (`sk-ant-`), AWS access key id (`AKIA`/`ASIA`), Slack (`xox[abprs]-`) and PEM private-key shapes, each checked for length and charset. A finding names the token's kind (`<location> credential-token github`) and never the token. The rule is never allowable, and the report summary gains a `credential-token` count.
