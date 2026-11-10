---
"@titan-design/agent-surface": patch
---

An interactive launch no longer forwards SIGHUP to the child, which already receives it from the terminal's process group. Headless launches still forward it.
