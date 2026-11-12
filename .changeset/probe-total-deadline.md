---
"@titan-design/factory": patch
---

The digest's console probe now gives up after a fixed total time instead of a socket-idle time, so a console that drips its reply slowly can no longer hold the digest open.
