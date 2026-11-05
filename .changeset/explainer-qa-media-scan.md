---
"@titan-design/explainer": minor
---

The qa stage runs render-qa's `mediaScan` over the MP4 through `QaEngine.mediaScan`, records it in `qa.json` as
`mediaScan` (each black, silent and frozen stretch with the beats it overlaps), and reports `black-frames`,
`silence-2s` and `frozen-frames` as checks that never fail the stage.
