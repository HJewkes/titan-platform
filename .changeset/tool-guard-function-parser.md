---
"@titan-design/tool-guard": patch
---

Add `parseSnapshotFunctions`, which reads the `# Functions` section of a Claude Code shell snapshot into a table of function bodies and marks a body that is cut off or ends ambiguously as unreadable (TP-2701 a). Not wired into classification yet.
