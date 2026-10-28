---
"@titan-design/explainer": patch
---

Runtime defaults by audience (TP-4354). A type profile's `audience` carries `kind: public | assigned`, `assigned` when unset. A profile with no `runtime` of its own takes its audience's band: a public video runs 120-360 s (target 240 s) and splits past 360 s, an assigned one keeps 600 s within 480-720. An explicit band still wins, so the daily overview keeps 180 s within 120-240. The repo tour now takes the assigned band instead of repeating it, and the repo argument is marked public. When a plan runs past its profile's split line, the script stage's runtime gate names the episodes to split it into at chapter breaks, and names any chapter too long for one episode as the one to split by section, rather than leaving the plan to be trimmed. The script stage version moves to x18.
