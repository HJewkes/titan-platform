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

`playwright-core` is a peer dependency; install a Chromium headless shell for it with
`pnpm exec playwright-core install --only-shell chromium`. The encoder and `mixAudio`
need `ffmpeg` on `PATH`.
