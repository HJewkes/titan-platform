---
"@titan-design/explainer": minor
---

The render stage's `timeline.json` now carries what the template fill drew beside each beat's slots (TP-4276 P0). `boardFromFill` returns `{ board, extras }`, where `extras` holds a `PageExtras` per storyboard id, in fill order: the fill's `reveals`, `chips` and `hints`, the `headline` (the beat's `visual.assertion`) and its `chapter { n, of, label }`. `compileTimeline` takes them as an optional `extras` side input and writes each beat's `reveals` as `{ target, part?, atS }`, with `atS` resolved from the reveal's cue word by the same cue resolver as the beat's cues. A provisional timeline places each reveal at its planned word time, scaled to the planned seconds. A reveal whose cue is never spoken throws, naming the beat. `TimelineBeat` gains `reveals`, `chips`, `hints`, `headline` and `chapter` as optional fields. With no extras the timeline bytes are unchanged.
