---
"@titan-design/tool-guard": patch
---

tool-guard walks a top-level `(( … ))` on the Bash tool's own line as an arithmetic command with no command words. A span only arithmetic can hold is no longer reported as a nested subshell that runs its words; substitutions inside it are still walked, and any other span, a `((` or `))` split by a backslash-newline, and every nested shell text keep the nested-subshell reading.
