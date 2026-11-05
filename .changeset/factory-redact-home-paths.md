---
"@titan-design/factory": patch
---

Export `redactHomePaths`, which maps `/Users/<u>`, `/home/<u>` and `/root` to `~` at a path boundary, and use it for the seat-check reason.
