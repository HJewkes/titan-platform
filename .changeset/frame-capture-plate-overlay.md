---
'@titan-design/frame-capture': minor
---

Add `transparent` to `PageOptions` and `FramesOptions`, which captures frames with alpha 0 where the page paints nothing, and an optional plate mp4 on `startEncoder`, which composites the PNG frames over it with an ffmpeg overlay filter.
