---
"@titan-design/github": patch
"@titan-design/factory": patch
---

Read Actions job logs with `--allow-escape-sequences` and strip the colour codes, so `jobLogTail` stops failing with "HTTP 200" (TP-2665); `failureOf` no longer reports a 2xx as an HTTP error.
