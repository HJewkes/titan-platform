# @titan-design/render-qa

## 0.1.0

### Minor Changes

- f33a768: Resolve's $0 layer build check now holds custom-layer text to qa's low-contrast rule (TP-4525). A layer whose text sits under the ratio its size needs gets one rebuild, told the text, its colour on its ground, the ratio and the fix: the fill's on- text token, such as `var(--color-on-brand-primary)` on `var(--color-brand-primary-solid)`, or a darker fill. The builder doctrine says the same. render-qa's `low-contrast` finding now carries the `need` it was held to and the text and ground colours as drawn (`fg`, `bg`). The resolve stage version moves to p5c2s2f2s2d6.
- 9761039: Add render-qa, a private port of the motion spike's render QA gate: the in-page inspector, cue moments, the persistence rule, page sessions and annotated crops, with the data-qa-\* protocol documented.
- 54d376e: Add `mediaScan(video, { exec? })`: black (`BLACK_MIN_S`), silent (`SILENCE_NOISE_DB`, `SILENCE_MIN_S` 2 s) and frozen
  (`FREEZE_MIN_S`) stretches of a video from one ffmpeg pass of blackdetect, silencedetect and freezedetect, and
  `parseMediaScan` for the stderr log alone. `spawnFfmpeg` takes `read: 'stderr'` to yield the log instead of stdout.
- 588a996: `off-frame` findings now carry `parked: true` when the painted rect has no area on the frame, and `classify` drops a parked finding when the element paints on frame at a later sample of its beat, so a card waiting for its cue is no longer a held error. A card that never enters during its beat stays off-frame, and a card partly past an edge is judged as before. The explainer's render and qa stage versions are bumped.
- 6e6cc79: Add sweepMoments (a 2 Hz grid from the video start with a settleBy rule, equal to the archived sweep golden), probeMoments (text line boxes, clipping ancestors and content boxes per moment) and frameDiffs (changed-pixel share per frame through ffmpeg).

### Patch Changes

- b38872f: A held finding whose rect lies wholly past a frame edge no longer crashes the qa crop with an empty clip. The crop is the padding-wide band at the nearest edge, and the row is kept.
- f0447dc: The probe's content check now reads a computed background by function, so `color(display-p3 ...)`, `oklch(...)` and other modern colour spaces no longer count the space name or a percentage as a channel. A fill paints when its alpha is above the same small threshold as before; `rgb` and `rgba` behave as they did.
- 8e60637: Judge off-frame and the other box rules on an element's painted rect: its box less what its `clip-path: inset(...)`
  and its ancestors' hide. A fully clipped box is not judged; percentage insets are read as percentages, and under a
  rotation or skew the layout box is kept.
- 598cf01: `frameDiffs` no longer counts a one-frame codec blip as picture change (TP-4558). An h264 keyframe re-quantises a still picture for one frame, a few levels on a few hundred pixels, and the next frame returns to the picture exactly. That frame now reads as its predecessor, so the static-window gate sees one still instead of two short ones. A one-frame change of more than 12 levels, or one the next frame keeps, still counts. The explainer qa stage version moves to x11c.
- Updated dependencies [e061751]
- Updated dependencies [c84d450]
- Updated dependencies [8ba8338]
- Updated dependencies [0f082a2]
- Updated dependencies [014b439]
- Updated dependencies [3035536]
- Updated dependencies [f799002]
- Updated dependencies [4b04b28]
  - @titan-design/frame-capture@0.2.0
