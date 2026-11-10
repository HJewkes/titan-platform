---
'@titan-design/active-work': patch
---

`mcp restart` now reports the serving daemon's pid from `/health`, the one `mcp status` and the pid file show, instead of the successor wrapper's pid.
