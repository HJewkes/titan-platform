# @titan-design/frame-capture

## 0.2.0

### Minor Changes

- e061751: `captureFrame` screenshots through `Page.captureScreenshot` with `optimizeForSpeed`: the same pixels, deterministic bytes, larger PNGs, and about 40% less time per 1920x1080 frame. The new `screenshotFrame` export takes the same screenshot, so a caller comparing bytes against a capture uses the same encoder.
- 7afbca0: Add `checkPops`, a pop check for captured timelines. It seeks a grid of `t`; where a step's change reaches a threshold it re-measures the step at h/2, h/4 and h/8 and reports a pop only when the change does not halve, so a mount, cut or jump is flagged and fast smooth motion is not. `measureHalving`, `isPop` and `changedPixels` (a pixel-count delta for raw RGBA frames) are exported with it. The halving test is adapted from anatomy's `kit/turn-audit.mjs` (MIT, attributed in NOTICE).
- 8ba8338: Spill frames waiting on the head chunk to disk. `captureFrames` with `workers` above 1 now requires `spillDir`, a sink slower than capture holds workers back, and a failure stops every worker and removes the spill before the capture rejects.
- 0f082a2: The virtual clock now covers `Date()` called without `new` (it threw before) and `document.timeline.currentTime`, and drives CSS animations, CSS transitions and Web Animations: after each timer, frame and seek, `__virtualTime.syncAnimations()` pauses every animation the page left running and sets it to virtual time. `openCapturePage` syncs once after load so load-time animations start at 0. An animation the page pauses or seeks itself is left to the page.
- 014b439: `captureFrames` takes an optional `browser` to capture in and leaves it open; without one it launches its own, and now reuses the probe's browser for the first chunk, saving one launch per capture. New `withBrowser` and `withCapturePage` helpers; `openCapturePage` closes its context when the open fails.
- 3035536: `captureFrames` takes an optional `beatStartsS`: parallel chunks then start only on beat starts, packed into at most `workers` chunks balanced by frame count, so a parallel render matches a sequential one frame for frame. Without it, chunks split by frame count as before.

### Patch Changes

- d14255f: `startEncoder` now listens for `error` on ffmpeg's stdin. An ffmpeg that dies mid-encode rejects the pending `write` and `finish` with its exit reason (the EPIPE kept as `cause`) instead of crashing the process with an uncaught EPIPE, and a death between writes no longer leaves an unhandled rejection.
- 45974cb: `checkPops` now throws a RangeError naming `start` and `end` when `start` is after `end`, instead of seeking `undefined`.
- c84d450: `screenshotFrame` waits 150 ms before its one retry of a "Unable to capture screenshot" answer; the immediate retry failed the same way under CI load. Any other error still throws.
- f799002: An unloaded font now fails `openCapturePage` with a `FontLoadError` that names each face and the font URLs the browser could not fetch. Resolve's build-time text check treats any throw from the check as an infrastructure fault, not a layer defect: the layer is not rebuilt, the reason reads "layer check could not run, not a layer defect", and a failed resolve stores the sources of every layer it built under `custom-layers-unbuilt` in the failed record. A new $0 font check on built layer sources (`@font-face`, font imports, `url()` to font files, remote font hosts, a `fontFamily` outside the `--font-family-*` tokens) rebuilds a layer once, naming the line and the theme tokens; the builder doctrine gains the same rule, which changes the builder's base prompt sha and so its build-cache keys.
- 4b04b28: Name each capture's spill directory after its process and sweep the spills of dead processes before a capture spills. A render killed mid-capture no longer leaves its frames on disk for good; a live process's spill is never touched, and a sweep failure does not fail the capture.

## 0.1.0

### Minor Changes

- 685eb4e: Add frame-capture: a virtual-time capture loop for any page that speaks the `__titanMotion` protocol, with parallel chunks, a page-error fail, a font-load check and an ffmpeg encoder (TP-2609).
