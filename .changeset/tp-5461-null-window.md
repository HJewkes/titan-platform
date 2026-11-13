---
"@titan-design/anthropic-account": patch
---

A usage reading whose window is `null` (the API's answer for an idle five-hour window) no longer discards the whole reading, so `status --statusline` prints the figures instead of the unknown line.
