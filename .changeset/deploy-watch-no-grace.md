---
"@titan-design/factory": patch
---

The deploy watch's docs say why it has no start-up grace: the sha poll already waits for a first answer, and three live-pid misses take about 135 s, past the 120 s window and the 17–32 s Shepherd resync after a restart.
