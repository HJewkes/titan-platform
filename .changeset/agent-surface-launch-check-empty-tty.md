---
"@titan-design/agent-surface": patch
---

State the launch check's rule for a pane whose tty stays empty: it counts as absent once the deadline passes. The header comment and the reference page's Gotchas now say so, and a regression test pins it. No behaviour change.
