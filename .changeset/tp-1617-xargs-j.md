---
"@titan-design/tool-guard": patch
---

Read BSD `xargs -J replstr` as an insert string: each run's input items are spliced in at the argument equal to it, so a push or merge target piped through `-J` is classified, and unreadable stdin fails closed as it does for `-I`.
