---
"@titan-design/factory": patch
---

The factory's `shepherd` /events frames now carry an optional `workflow` ("autoresearch" or "shepherd") derived from the run's workflow, so the console refetches autoresearch reads only for autoresearch runs. Additive: a frame without it means the same as before.
