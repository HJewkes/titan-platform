---
"@titan-design/explainer": minor
---

The qa stage samples render-qa's 2 Hz sweep with its cue moments (variant param `sweep: false` keeps the cue moments
only), and an outro beat settles 1 s before its end, ahead of its fade. It runs `frameDiffs` on the MP4 and
`probeMoments` on the page, and gates `motion-happened`, `clipped-text` and `content-fill` (60 %) and reports
`stage-empty`, each finding by beat and anchor. `qa.json` gains `sweep`, `framediff`, `probe` and `measured`.
