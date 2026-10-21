# @titan-design/frame-capture

Deterministic frame capture of any page that speaks the `__titanMotion` protocol.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.
It imports nothing from titan-design and no React: it reaches the page only through
the protocol below.

## The `__titanMotion` protocol

A page that wants to be captured publishes one object as `window.__titanMotion`
(exported as the `TitanMotionApi` type and the `TITAN_MOTION_GLOBAL` name):

| Member | Contract |
|---|---|
| `seek(t)` | Shows the frame at `t` seconds, committed synchronously |
| `ready()` | Resolves once that frame has nothing left to load |
| `duration` | The timeline length in seconds |

titan-design's react-ui `MotionProvider` on a `seekClock` publishes exactly this
shape. Any other page can publish it by hand.

## Use

```ts
import { captureFrames, startEncoder } from "@titan-design/frame-capture";

const encoder = startEncoder("out.mp4", 30, "mix.wav");
await captureFrames({ url, fps: 30, width: 1920, height: 1080, workers: 8 }, (_, png) => encoder.write(png));
await encoder.finish();
```

With `workers` above 1, pass `beatStartsS` (the seconds at which the page lays out a fresh
scene) so every chunk starts on a beat: the render then matches a sequential one frame for
frame. Without it, chunks split by frame count and can start mid-beat.

`playwright-core` is a peer dependency; install a Chromium headless shell for it with
`pnpm exec playwright-core install --only-shell chromium`. The encoder and `mixAudio`
need `ffmpeg` on `PATH`.

## Virtual time

`VIRTUAL_TIME_SCRIPT` runs before any page script. `Date` (called with or without `new`),
`performance.now`, `document.timeline.currentTime`, timers and `requestAnimationFrame` all read a
clock that only `__virtualTime.advanceTo(ms)` moves, and `Math.random` is seeded.

CSS animations, CSS transitions and Web Animations follow the same clock. After each timer,
each frame and each seek, `__virtualTime.syncAnimations()` pauses every animation the page left
running and sets its `currentTime` to the virtual time since the clock first saw it.
`openCapturePage` syncs once after load, so animations the page starts while loading begin at 0.

What stays the page's job:

- An animation the page pauses, seeks or replays itself is left to the page.
- A transition or animation starts at the seek that triggers it, so it depends on the frames
  before it: a frame reached by a jump can differ from the same frame in a sweep. A seekable
  page derives its motion from `t`.
