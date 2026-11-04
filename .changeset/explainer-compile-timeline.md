---
"@titan-design/explainer": minor
---

Add `compileTimeline` and `writeTimeline`: a storyboard plus an optional words.json compile to the composition page's
`timeline.json`, with heard durations and beat-local cue seconds, or planned durations and `provisional: true` without
words, and slots parsed by `BEAT_SLOTS`. Storyboard beats gain optional `cues` (`word` or `word#n`).
