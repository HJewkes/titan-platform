---
"@titan-design/factory": patch
---

Shepherd types agent presence as one `Presence` union (live, detached, exiting, exited, deregistered), and its merge-evidence and verdict-locator step outputs are parsed against their real shape instead of cast.
