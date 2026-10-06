---
"@titan-design/tool-guard": patch
---

Read BSD `xargs -J replstr` as an insert string: each run's input items are spliced in at the argument equal to it, so a push or merge target piped through `-J` is classified, and unreadable stdin fails closed as it does for `-I`. A separate `-I` or `-J` value that looks like an option (`-J -i`) is read as the value, and input quotes and backslashes are also read as xargs drops them when it splits on blanks. These added readings are dropped when the script they build cannot parse, and past 256 runs they fail closed to the worst case, so a long input cannot hold the hook past its timeout.
