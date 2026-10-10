---
"@titan-design/anthropic-account": minor
---

Add the `anthropic-account` bin: `poll [--write [--refresh]]` and `status [--json | --statusline]`. A login that is not present exits 2 with one fixed stderr line per account. `poll --write --refresh` renews due access tokens with `refreshIfNeeded` before polling, so it writes `.credentials.json`. The package now ships systemd user templates in `systemd/` that run it every 150 s; nothing is installed or enabled.
