---
"@titan-design/tool-guard": patch
---

Read a dynamic command word (`"$G" push origin HEAD:main`) as each guarded command whose verb follows it, so a guarded push, merge or release behind a variable is classified instead of passing; a word followed by no guarded verb gives no verdict.
