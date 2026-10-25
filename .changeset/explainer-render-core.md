---
"@titan-design/explainer": minor
---

Add the render core (TP-2992 S1). `renderVideo` captures a served timeline page through `@titan-design/frame-capture` and writes `<stem>.mp4` (H.264 + AAC), `captions.vtt` and an `explainer.render-manifest/v1` with workers, frames, durations, the draft flag, `qaGate: "absent"`, a host block with no hostname or paths, and the shas of what it wrote. A render with no narration gets a sample-exact silent AAC track and `draft: true`. `assertDurationAgreement` refuses a page and mix that disagree on length; the partial mp4 is deleted and no manifest is written. Captions are ported from the spike: 42 characters or 8 words a cue, broken at sentence ends. No CLI or stage wiring yet.
