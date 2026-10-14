# frame-capture

**Tier 1.** No titan dependencies. `playwright-core` is a peer dependency; the encoder needs
`ffmpeg` on `PATH`.

```sh
npm install @titan-design/frame-capture playwright-core
pnpm exec playwright-core install --only-shell chromium
```

## The problem it solves

A video made from a web page has to be captured frame by frame, and a screenshot loop over a
live page is not deterministic: timers, `Date.now`, `requestAnimationFrame` and
`Math.random` all read real time, fonts load lazily, and a render that throws leaves a blank
page that still screenshots. This package is the capture loop that removes each of those. It
installs a virtual clock before any page script runs, seeks the page through one small
protocol, waits for it to be ready, and fails the capture on a page error or a font face that
did not load.

## When to reach for it

- You render an MP4 or stills from any page that publishes `window.__titanMotion`, such as a
  titan-design `MotionProvider` on a `seekClock`.
- You need two captures of the same page to be byte-identical, for a seek diff or a review
  clip.

Not for deciding what is on the page: timelines, beats and their schemas belong to the
product that builds the page. Not for judging the frames: layout and legibility checks are
render-qa's job.

## The `__titanMotion` protocol

| Member | Contract |
|---|---|
| `seek(t)` | Shows the frame at `t` seconds, committed synchronously |
| `ready()` | Resolves once that frame has nothing left to load |
| `duration` | The timeline length in seconds |

The type is `TitanMotionApi` and the global's name is `TITAN_MOTION_GLOBAL`. The shape
matches titan-design's `TitanMotionApi` in react-ui `/motion`; the two are pinned by
contract, not by an import.

## Example

Written against the 0.1.0 API. The package's tests drive `captureFrames` the same way against
a fixture page; the encoder half is not covered by a test yet.

```ts
import { captureFrames, mixAudio, startEncoder } from "@titan-design/frame-capture";

await mixAudio([{ id: "intro", durationS: 4 }], (id) => `audio/${id}.wav`, "mix.wav");
const encoder = startEncoder("out.mp4", 30, "mix.wav");
const result = await captureFrames(
  { url: "http://127.0.0.1:4173/", fps: 30, width: 1920, height: 1080, workers: 8 },
  (_, png) => encoder.write(png),
);
await encoder.finish();
console.log(result.frames, result.pageDurationS);
```

## What it deliberately does not do

- It imports no React and nothing from titan-design.
- It has no notion of beats, timelines, captions or chapters.
- It does not serve or build the page; pass it a URL.

## Gotchas

- `captureFrames` gives each worker its own browser, because screenshots encode in the
  browser process. A fixed worker count renders byte-identically run to run, but a chunk's
  first frames can differ from a sequential render by a few levels of anti-aliasing.
- `openCapturePage` listens for page errors before it navigates, so a page that throws while it
  loads fails the open instead of answering every seek with a blank frame. The same list,
  `CapturePage.errors`, fails a later frame. A `duration` that is missing, NaN or not positive
  also fails the open, rather than resolving with zero frames.
- `seek` must commit synchronously. A page that commits on a later timer is captured one
  frame late, because virtual time only moves when the capture advances it.
- `preloadFonts: false` turns off both the explicit font load and the unloaded-face check. It
  exists to measure what the load prevents, not for production renders.
- The virtual clock starts at 2026-01-01T00:00:00Z, and `Math.random` is seeded.

## Where it came from

Ported from the motion-spike capture loop (`capture/src`), which rendered the spike's
explainer videos. The spike's page fixtures, its timeline rule and its render scripts stayed
behind: they are product policy.
