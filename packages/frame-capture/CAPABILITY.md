# frame-capture: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need deterministic PNG frames, or an MP4, of a web page that animates on a timeline: the page publishes `window.__titanMotion` (`seek(t)`, `ready()`, `duration`) and `captureFrames` drives it under a virtual clock (`VIRTUAL_TIME_SCRIPT`) across parallel Playwright browsers, failing on any page error or unloaded font face; `startEncoder` and `mixAudio` wrap ffmpeg. It does not know what a beat or a timeline is: the motion runtime that publishes the protocol is titan-design's react-ui `/motion`, and composing a video is a product's job.
