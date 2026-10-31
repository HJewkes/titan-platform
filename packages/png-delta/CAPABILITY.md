# png-delta: use this when

You hold two untrusted PNG screenshots, a base and a head, and need to know how much of the rendered content changed (`snapshotShare`), see which pixels moved (`pixelDelta`, drawn by pixelmatch, then `encodePng`), or decode one PNG under a hard pixel cap (`decodePngBounded`). For capturing frames of a page use `frame-capture`; for per-frame change counts across an MP4 use `render-qa`.
