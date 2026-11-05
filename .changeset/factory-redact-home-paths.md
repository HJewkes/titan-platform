---
"@titan-design/factory": patch
---

Export `redactHomePaths`, which maps `/Users/<u>`, `/home/<u>` and `/root` to `~` wherever they appear, and use it for the seat-check reason.
