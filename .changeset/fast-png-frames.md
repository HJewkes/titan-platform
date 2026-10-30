---
"@titan-design/frame-capture": minor
---

`captureFrame` screenshots through `Page.captureScreenshot` with `optimizeForSpeed`: the same pixels, deterministic bytes, larger PNGs, and about 40% less time per 1920x1080 frame. The new `screenshotFrame` export takes the same screenshot, so a caller comparing bytes against a capture uses the same encoder.
