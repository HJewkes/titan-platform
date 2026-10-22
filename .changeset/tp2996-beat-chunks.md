---
"@titan-design/frame-capture": minor
---

`captureFrames` takes an optional `beatStartsS`: parallel chunks then start only on beat starts, packed into at most `workers` chunks balanced by frame count, so a parallel render matches a sequential one frame for frame. Without it, chunks split by frame count as before.
