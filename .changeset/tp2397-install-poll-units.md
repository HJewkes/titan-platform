---
"@titan-design/anthropic-account": minor
---

Add `anthropic-account install|uninstall [--dry-run]`. On linux it writes the shipped poll units into the systemd user dir and enables the timer; on darwin it writes a launchd agent that runs `poll --write` (no `--refresh`) every 150 s and bootstraps it.
