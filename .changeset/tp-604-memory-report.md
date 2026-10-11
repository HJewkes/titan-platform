---
"@titan-design/session-miner": minor
---

Add `titan-miner memory scan` and `titan-miner memory report`. They read every Claude Code auto-memory directory, then dedupe, group and propose a destination per group. The report is written as `report.md` and `decisions.yml`, mode 0600, and the envelope carries counts and paths only.
