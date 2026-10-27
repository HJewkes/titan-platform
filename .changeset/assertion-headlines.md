---
"@titan-design/explainer": minor
---

Q-D7 assertion headlines (TP-4328). Every beat's `visual.assertion` must be a claim, a subject and a finite verb in at most ten words, and when the beat carries `authored` it must be written before the narration. The verb test reads speech-g2p's part-of-speech tags, so it costs no model call. Failing rows get a repair hint naming each defect. A new `talks-ST11` craft line tells the planner to plan each headline first, and the planner guides carry it.
