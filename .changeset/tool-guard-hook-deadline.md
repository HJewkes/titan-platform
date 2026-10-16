---
"@titan-design/tool-guard": patch
---

The hook now classifies in a worker thread and denies a call it has not answered 3.5 s after node starts, or whose worker throws or exits, instead of being killed by Claude Code's 5 s hook timeout and letting the call run unchecked (TP-3224).
