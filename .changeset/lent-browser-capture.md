---
"@titan-design/frame-capture": minor
---

`captureFrames` takes an optional `browser` to capture in and leaves it open; without one it launches its own, and now reuses the probe's browser for the first chunk, saving one launch per capture. New `withBrowser` and `withCapturePage` helpers; `openCapturePage` closes its context when the open fails.
