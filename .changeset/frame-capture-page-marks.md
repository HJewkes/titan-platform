---
'@titan-design/frame-capture': minor
---

Read an optional `__titanMotion.marks()` once after the page's API appears. `captureFrames` returns the marks on `FramesResult.marks`, sorted by `t`, or `[]` for a page without `marks()`. A mark with a non-finite `t` or an unknown `kind` rejects the capture with an error that names the mark.
