---
"titan-console": patch
---

Add `titan-console link gate <run>/<step>`, which prints the https link to a gate only after an https request to it answers 200 or 401, and exits 1 on an empty reply, a connection error, another status, or a console with no LAN listener.
