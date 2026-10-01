---
"@titan-design/factory": patch
---

TP-637: Shepherd's seat book accepts repo and deny_repos paths whose segments contain inner spaces, such as `~/Library/Application Support/x`. Leading or trailing spaces, glob characters, quotes, backslashes and dot segments stay refused.
