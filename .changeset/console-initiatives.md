---
"titan-console": minor
---

Add the Initiatives view: `#/initiatives` shows the active-work portfolio with open-task rollups, note, source and session counts and newest activity, and `#/initiatives/<slug>` shows one initiative's brief, open loops, open tasks, recent sessions, notes and sources. The daemon gains `work.portfolio` and `work.initiative`, which read the active-work daemon over loopback. Personal initiatives are flagged in the console and left out of the exported page.
