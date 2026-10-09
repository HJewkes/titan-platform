---
"@titan-design/factory": patch
---

ci-wait no longer reads a superseded cancelled run as red. When a newer run of the same check exists on the head, the older cancelled run is ignored, so a newer queued run reads pending and a newer success reads green. A cancelled run with no newer run of its name stays red.
