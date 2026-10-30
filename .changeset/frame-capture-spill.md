---
"@titan-design/frame-capture": minor
---

Spill frames waiting on the head chunk to disk. `captureFrames` with `workers` above 1 now requires `spillDir`, a sink slower than capture holds workers back, and a failure stops every worker and removes the spill before the capture rejects.
