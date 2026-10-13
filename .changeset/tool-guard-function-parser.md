---
"@titan-design/tool-guard": patch
---

Add `parseSnapshotFunctions`, which reads the `# Functions` section of a Claude Code shell snapshot into a table of function bodies (TP-2701 a). A body ends at the first column-0 `}` outside every heredoc, quote and substitution, so verbatim text inside a body cannot end it or redefine another function. A body that never closes is unreadable, and a section that cannot be read to its end marks the table `incomplete`. Not wired into classification yet.
