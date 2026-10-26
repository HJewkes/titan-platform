---
"@titan-design/agent": patch
---

The claude-print harness now passes `--disable-slash-commands`, so a one-turn call loads no skills or commands and a prompt that opens with `/` is read as text.
