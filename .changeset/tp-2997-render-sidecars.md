---
"@titan-design/explainer": minor
"@titan-design/frame-capture": minor
---

Render sidecars (TP-2997). The render stage writes the script's chapters, the tts voice block and each stage's
StepUsage (cost and wall time, from the run's stage records, with render's own row on the injected clock) into
`render-manifest.json`. Chapters tile the video: the first opens at 0 and each ends where the next opens.
frame-capture exports `stills()`, true-size PNGs of one page at chosen seconds, taken in time order on one page.
