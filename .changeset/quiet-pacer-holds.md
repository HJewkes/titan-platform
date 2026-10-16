---
"@titan-design/factory": patch
---

The deploy watch no longer rolls back on a rate-limited probe. A 403, 422 or 429 from `/health` reads as unavailable, which is neither healthy nor an error: the window extends, restarts on fresh probes once reads return, and at a 10-minute cap the deploy is held with an alarm instead of rolled back. TP-3085.
