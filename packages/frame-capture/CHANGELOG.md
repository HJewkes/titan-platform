# @titan-design/frame-capture

## 0.2.0

### Minor Changes

- 0f082a2: The virtual clock now covers `Date()` called without `new` (it threw before) and `document.timeline.currentTime`, and drives CSS animations, CSS transitions and Web Animations: after each timer, frame and seek, `__virtualTime.syncAnimations()` pauses every animation the page left running and sets it to virtual time. `openCapturePage` syncs once after load so load-time animations start at 0. An animation the page pauses or seeks itself is left to the page.
- 3035536: `captureFrames` takes an optional `beatStartsS`: parallel chunks then start only on beat starts, packed into at most `workers` chunks balanced by frame count, so a parallel render matches a sequential one frame for frame. Without it, chunks split by frame count as before.

## 0.1.0

### Minor Changes

- 685eb4e: Add frame-capture: a virtual-time capture loop for any page that speaks the `__titanMotion` protocol, with parallel chunks, a page-error fail, a font-load check and an ffmpeg encoder (TP-2609).
